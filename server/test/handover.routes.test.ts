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
import { insertHandover } from '../src/repos/callHandovers.js';
import { seedInboundCall } from './helpers/lineReport.js';

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
  smtp = startTestSmtp(2535);
  app = await buildApp({ cfg });
});
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await smtp.close(); await pool.end(); });

async function adminSession() {
  const t = await createTenant(pool);
  const password = 'pw-12345678';
  await createUser(pool, { tenantId: t.id, email: 'admin@h.io', password, role: 'tenant_admin' });
  const csrf = await csrfFor(app);
  const headers = await login(app, { email: 'admin@h.io', password }, csrf);
  return { tenantId: t.id, headers, csrf };
}

async function nonAdminSession(tenantId: string) {
  const password = 'pw-99999999';
  await createUser(pool, { tenantId, email: 'user@h.io', password, role: 'tenant_user' });
  const csrf = await csrfFor(app);
  const headers = await login(app, { email: 'user@h.io', password }, csrf);
  return { headers, csrf };
}

async function seedSender(tenantId: string) {
  const sc = await createSmtpConfig(pool, KEY, {
    tenantId, name: 'local', host: '127.0.0.1', port: 2535, secure: false,
    username: 'u', password: 'p', fromDomain: 'h.com', isDefault: true,
  });
  await createSender(pool, { tenantId, email: 'abe@h.com', displayName: 'Abe', smtpConfigId: sc.id, isDefault: true });
}

async function seedPendingHandover(tenantId: string) {
  const { id: messageId } = await seedInboundCall(pool, tenantId, 'call about fraud');
  return insertHandover(pool, {
    tenantId, messageId, callerName: 'Alice', callerPhone: '0820000001',
    reasonCategory: 'Card disputes / fraud', summary: 'Caller reports suspicious transaction.',
    recommendedAction: 'Call back urgently.', urgency: 'high', vulnerable: false, missingFields: [],
  });
}

// ── GET /api/agent/handovers ──────────────────────────────────────────────────
describe('GET /api/agent/handovers', () => {
  it('returns 403 for non-admin', async () => {
    const { tenantId } = await adminSession();
    const { headers } = await nonAdminSession(tenantId);
    const res = await app.inject({ method: 'GET', url: '/api/agent/handovers', headers });
    expect(res.statusCode).toBe(403);
  });

  it('returns 200 with handovers array for admin', async () => {
    const { headers } = await adminSession();
    const res = await app.inject({ method: 'GET', url: '/api/agent/handovers', headers });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().handovers)).toBe(true);
  });
});

// ── GET /api/agent/handovers/:id ─────────────────────────────────────────────
describe('GET /api/agent/handovers/:id', () => {
  it('returns 404 for unknown id', async () => {
    const { headers } = await adminSession();
    const res = await app.inject({
      method: 'GET', url: '/api/agent/handovers/00000000-0000-0000-0000-000000000000', headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it('cross-tenant: tenant A admin cannot see tenant B handover (404)', async () => {
    const a = await adminSession();
    const tB = await createTenant(pool);
    const { id: msgId } = await seedInboundCall(pool, tB.id, 'tenant B call');
    const hB = await insertHandover(pool, {
      tenantId: tB.id, messageId: msgId, callerName: 'Bob', callerPhone: '0821111111',
      reasonCategory: 'Other', summary: 'some summary', recommendedAction: 'none',
      urgency: 'low', vulnerable: false, missingFields: [],
    });
    const res = await app.inject({
      method: 'GET', url: `/api/agent/handovers/${hB.id}`, headers: a.headers,
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── POST /api/agent/handovers/:id/forward ────────────────────────────────────
describe('POST /api/agent/handovers/:id/forward', () => {
  it('forwards handover, marks status forwarded, creates emails row to ABSA', async () => {
    const { tenantId, headers, csrf } = await adminSession();
    await seedSender(tenantId);
    await upsertLineReportConfig(pool, tenantId, { enabled: true, recipients: ['callbacks@absa.co.za'] });
    const handover = await seedPendingHandover(tenantId);

    const recv = smtp.lastMail();
    const res = await app.inject({
      method: 'POST', url: `/api/agent/handovers/${handover.id}/forward`,
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().handover.status).toBe('forwarded');

    const emailRow = await pool.query(
      `SELECT * FROM emails WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1`, [tenantId],
    );
    expect(emailRow.rowCount).toBeGreaterThan(0);
    expect(emailRow.rows[0].to_addr).toBe('callbacks@absa.co.za');

    const mail = await recv as { headers: Record<string, string> };
    expect(mail.headers.to).toContain('callbacks@absa.co.za');
  });

  it('second forward returns 400 and email count is unchanged (atomic, no double-send)', async () => {
    const { tenantId, headers, csrf } = await adminSession();
    await seedSender(tenantId);
    await upsertLineReportConfig(pool, tenantId, { enabled: true, recipients: ['callbacks@absa.co.za'] });
    const handover = await seedPendingHandover(tenantId);
    const h = { ...headers, 'x-csrf-token': csrf.csrfToken };

    const first = await app.inject({ method: 'POST', url: `/api/agent/handovers/${handover.id}/forward`, headers: h });
    expect(first.statusCode).toBe(200);
    const after1 = await pool.query(`SELECT count(*)::int AS n FROM emails WHERE tenant_id=$1`, [tenantId]);

    const second = await app.inject({ method: 'POST', url: `/api/agent/handovers/${handover.id}/forward`, headers: h });
    expect(second.statusCode).toBe(400);
    expect(second.json().error.code).toBe('cannot_forward');
    const after2 = await pool.query(`SELECT count(*)::int AS n FROM emails WHERE tenant_id=$1`, [tenantId]);
    expect(after2.rows[0].n).toBe(after1.rows[0].n); // no second send
  });

  it('returns 403 for non-admin', async () => {
    const { tenantId } = await adminSession();
    const handover = await seedPendingHandover(tenantId);
    const { headers, csrf } = await nonAdminSession(tenantId);
    const res = await app.inject({
      method: 'POST', url: `/api/agent/handovers/${handover.id}/forward`,
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 400 when no recipients configured', async () => {
    const { tenantId, headers, csrf } = await adminSession();
    await seedSender(tenantId);
    await upsertLineReportConfig(pool, tenantId, { enabled: true, recipients: [] });
    const handover = await seedPendingHandover(tenantId);
    const res = await app.inject({
      method: 'POST', url: `/api/agent/handovers/${handover.id}/forward`,
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── POST /api/agent/handovers/:id/dismiss ────────────────────────────────────
describe('POST /api/agent/handovers/:id/dismiss', () => {
  it('dismisses handover with reason, sets dismiss_reason', async () => {
    const { tenantId, headers, csrf } = await adminSession();
    const handover = await seedPendingHandover(tenantId);
    const res = await app.inject({
      method: 'POST', url: `/api/agent/handovers/${handover.id}/dismiss`,
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
      payload: { reason: 'Caller resolved on call' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().handover.status).toBe('dismissed');
    expect(res.json().handover.dismiss_reason).toBe('Caller resolved on call');
  });

  it('returns 403 for non-admin', async () => {
    const { tenantId } = await adminSession();
    const handover = await seedPendingHandover(tenantId);
    const { headers, csrf } = await nonAdminSession(tenantId);
    const res = await app.inject({
      method: 'POST', url: `/api/agent/handovers/${handover.id}/dismiss`,
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});
