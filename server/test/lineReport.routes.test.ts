import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant, createUser } from './helpers/factories.js';
import { csrfFor, login } from './helpers/auth.js';
import { startTestSmtp } from './helpers/smtp.js';
import { createSmtpConfig } from '../src/repos/smtpConfigs.js';
import { createSender } from '../src/repos/senders.js';
import { upsertLineReportConfig } from '../src/repos/lineReportConfigs.js';
import { insertReport } from '../src/repos/lineReports.js';

const KEY = Buffer.alloc(32, 1);
const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: KEY.toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
  CRON_SECRET: 'c'.repeat(24),
});

let app: Awaited<ReturnType<typeof buildApp>>;
let smtp: ReturnType<typeof startTestSmtp>;
const pool = makePool();

beforeAll(async () => {
  smtp = startTestSmtp(2534);
  app = await buildApp({ cfg });
});
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await smtp.close(); await pool.end(); });

async function adminSession() {
  const t = await createTenant(pool);
  const password = 'pw-12345678';
  await createUser(pool, { tenantId: t.id, email: 'admin@x.io', password, role: 'tenant_admin' });
  const csrf = await csrfFor(app);
  const headers = await login(app, { email: 'admin@x.io', password }, csrf);
  return { tenantId: t.id, headers, csrf };
}

async function nonAdminSession(tenantId: string) {
  const password = 'pw-99999999';
  await createUser(pool, { tenantId, email: 'user@x.io', password, role: 'tenant_user' });
  const csrf = await csrfFor(app);
  const headers = await login(app, { email: 'user@x.io', password }, csrf);
  return { headers, csrf };
}

async function seedSender(tenantId: string) {
  const sc = await createSmtpConfig(pool, KEY, {
    tenantId, name: 'local', host: '127.0.0.1', port: 2534, secure: false,
    username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
  });
  await createSender(pool, { tenantId, email: 'abe@x.com', displayName: 'Abe', smtpConfigId: sc.id, isDefault: true });
}

describe('GET /api/agent/line-reports', () => {
  it('returns 403 for non-admin', async () => {
    const { tenantId, headers: adminHeaders } = await adminSession();
    const { headers } = await nonAdminSession(tenantId);
    const res = await app.inject({ method: 'GET', url: '/api/agent/line-reports', headers });
    expect(res.statusCode).toBe(403);
    void adminHeaders; // used in other tests
  });

  it('returns 200 with reports array for admin', async () => {
    const { headers } = await adminSession();
    const res = await app.inject({ method: 'GET', url: '/api/agent/line-reports', headers });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().reports)).toBe(true);
  });
});

describe('GET /api/agent/line-reports/:id', () => {
  it('returns 404 for unknown id', async () => {
    const { headers } = await adminSession();
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/line-reports/00000000-0000-0000-0000-000000000000',
      headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns the report by id', async () => {
    const { tenantId, headers } = await adminSession();
    const report = await insertReport(pool, {
      tenantId, reportType: 'digest', subject: 'My report', body: 'Hello',
      metrics: {}, sourceMessageIds: [],
    });
    const res = await app.inject({ method: 'GET', url: `/api/agent/line-reports/${report.id}`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().report.id).toBe(report.id);
  });

  it('does not leak another tenant\'s report (404)', async () => {
    const a = await adminSession();
    const tB = await createTenant(pool);
    const reportB = await insertReport(pool, {
      tenantId: tB.id, reportType: 'digest', subject: 'B-only', body: 'x',
      metrics: {}, sourceMessageIds: [],
    });
    const res = await app.inject({
      method: 'GET', url: `/api/agent/line-reports/${reportB.id}`, headers: a.headers,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /api/agent/line-reports/:id', () => {
  it('edits subject and body while pending_approval', async () => {
    const { tenantId, headers, csrf } = await adminSession();
    const report = await insertReport(pool, {
      tenantId, reportType: 'digest', subject: 'Old', body: 'Old body',
      metrics: {}, sourceMessageIds: [],
    });
    const res = await app.inject({
      method: 'PATCH', url: `/api/agent/line-reports/${report.id}`,
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
      payload: { subject: 'New', body: 'New body' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().report.subject).toBe('New');
    expect(res.json().report.body).toBe('New body');
  });

  it('rejects edit on non-pending_approval report', async () => {
    const { tenantId, headers, csrf } = await adminSession();
    const report = await insertReport(pool, {
      tenantId, reportType: 'digest', subject: 'S', body: 'B',
      metrics: {}, sourceMessageIds: [],
    });
    // Archive it first
    await pool.query(
      `UPDATE line_reports SET status = 'archived' WHERE id = $1`, [report.id],
    );
    const res = await app.inject({
      method: 'PATCH', url: `/api/agent/line-reports/${report.id}`,
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
      payload: { subject: 'New' },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('POST /api/agent/line-reports/:id/approve', () => {
  it('sends email, marks status sent, creates emails row', async () => {
    const { tenantId, headers, csrf } = await adminSession();
    await seedSender(tenantId);
    await upsertLineReportConfig(pool, tenantId, { enabled: true, recipients: ['ops@absa.co.za'] });

    const report = await insertReport(pool, {
      tenantId, reportType: 'digest', subject: 'Fraud report', body: 'Details here.',
      metrics: {}, sourceMessageIds: [],
    });

    const recv = smtp.lastMail();
    const res = await app.inject({
      method: 'POST', url: `/api/agent/line-reports/${report.id}/approve`,
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().report.status).toBe('sent');

    // Should have an email row
    const emailRow = await pool.query(
      `SELECT * FROM emails WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`, [tenantId],
    );
    expect(emailRow.rowCount).toBeGreaterThan(0);
    expect(emailRow.rows[0].to_addr).toBe('ops@absa.co.za');

    // SMTP should have delivered
    const mail = await recv as { headers: Record<string, string> };
    expect(mail.headers.to).toContain('ops@absa.co.za');
  });

  it('returns 400 when no recipients configured', async () => {
    const { tenantId, headers, csrf } = await adminSession();
    await seedSender(tenantId);
    await upsertLineReportConfig(pool, tenantId, { enabled: true, recipients: [] });

    const report = await insertReport(pool, {
      tenantId, reportType: 'digest', subject: 'S', body: 'B',
      metrics: {}, sourceMessageIds: [],
    });

    const res = await app.inject({
      method: 'POST', url: `/api/agent/line-reports/${report.id}/approve`,
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('cannot_send');
  });

  it('returns 400 when no default sender', async () => {
    const { tenantId, headers, csrf } = await adminSession();
    // No sender seeded
    await upsertLineReportConfig(pool, tenantId, { enabled: true, recipients: ['ops@absa.co.za'] });

    const report = await insertReport(pool, {
      tenantId, reportType: 'digest', subject: 'S', body: 'B',
      metrics: {}, sourceMessageIds: [],
    });

    const res = await app.inject({
      method: 'POST', url: `/api/agent/line-reports/${report.id}/approve`,
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('cannot_send');
  });

  it('a second approve does not re-send (atomic claim guards double-send)', async () => {
    const { tenantId, headers, csrf } = await adminSession();
    await seedSender(tenantId);
    await upsertLineReportConfig(pool, tenantId, { enabled: true, recipients: ['ops@absa.co.za'] });
    const report = await insertReport(pool, {
      tenantId, reportType: 'digest', subject: 'Once', body: 'Body',
      metrics: {}, sourceMessageIds: [],
    });
    const h = { ...headers, 'x-csrf-token': csrf.csrfToken };

    const first = await app.inject({ method: 'POST', url: `/api/agent/line-reports/${report.id}/approve`, headers: h });
    expect(first.statusCode).toBe(200);
    const after1 = await pool.query(`SELECT count(*)::int AS n FROM emails WHERE tenant_id=$1`, [tenantId]);

    const second = await app.inject({ method: 'POST', url: `/api/agent/line-reports/${report.id}/approve`, headers: h });
    expect(second.statusCode).toBe(400);
    expect(second.json().error.code).toBe('cannot_send');
    const after2 = await pool.query(`SELECT count(*)::int AS n FROM emails WHERE tenant_id=$1`, [tenantId]);
    expect(after2.rows[0].n).toBe(after1.rows[0].n); // no second send
  });

  it('returns 403 for non-admin', async () => {
    const { tenantId } = await adminSession();
    const report = await insertReport(pool, {
      tenantId, reportType: 'digest', subject: 'S', body: 'B',
      metrics: {}, sourceMessageIds: [],
    });
    const { headers, csrf } = await nonAdminSession(tenantId);
    const res = await app.inject({
      method: 'POST', url: `/api/agent/line-reports/${report.id}/approve`,
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /api/agent/line-reports/:id/reject', () => {
  it('archives the report with reject reason', async () => {
    const { tenantId, headers, csrf } = await adminSession();
    const report = await insertReport(pool, {
      tenantId, reportType: 'digest', subject: 'S', body: 'B',
      metrics: {}, sourceMessageIds: [],
    });

    const res = await app.inject({
      method: 'POST', url: `/api/agent/line-reports/${report.id}/reject`,
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
      payload: { reason: 'Not relevant' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().report.status).toBe('archived');
    expect(res.json().report.reject_reason).toBe('Not relevant');
  });
});

describe('GET /api/agent/line-report-settings', () => {
  it('returns null config when not set', async () => {
    const { headers } = await adminSession();
    const res = await app.inject({ method: 'GET', url: '/api/agent/line-report-settings', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().config).toBeNull();
  });
});

describe('PUT /api/agent/line-report-settings', () => {
  it('upserts and returns config', async () => {
    const { tenantId, headers, csrf } = await adminSession();
    const res = await app.inject({
      method: 'PUT', url: '/api/agent/line-report-settings',
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
      payload: { enabled: true, recipients: ['ops@absa.co.za'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().config.enabled).toBe(true);
    expect(res.json().config.recipients).toContain('ops@absa.co.za');

    // GET returns the same
    const get = await app.inject({ method: 'GET', url: '/api/agent/line-report-settings', headers });
    expect(get.json().config.enabled).toBe(true);
  });

  it('round-trips client_name and client_context', async () => {
    const { headers, csrf } = await adminSession();
    const res = await app.inject({
      method: 'PUT', url: '/api/agent/line-report-settings',
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
      payload: { clientName: 'ABSA', clientContext: 'iDirect overflow' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().config.client_name).toBe('ABSA');
    expect(res.json().config.client_context).toBe('iDirect overflow');

    const get = await app.inject({ method: 'GET', url: '/api/agent/line-report-settings', headers });
    expect(get.json().config.client_name).toBe('ABSA');
    expect(get.json().config.client_context).toBe('iDirect overflow');
  });
});
