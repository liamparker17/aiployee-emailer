import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant, createUser } from './helpers/factories.js';
import { csrfFor, login } from './helpers/auth.js';
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
const pool = makePool();

beforeAll(async () => {
  app = await buildApp({ cfg });
});
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await pool.end(); });

async function adminSession() {
  const t = await createTenant(pool);
  const password = 'pw-12345678';
  await createUser(pool, { tenantId: t.id, email: 'admin@x.io', password, role: 'tenant_admin' });
  const csrf = await csrfFor(app);
  const headers = await login(app, { email: 'admin@x.io', password }, csrf);
  return { tenantId: t.id, headers, csrf };
}

async function seedCallWithAttribution(tenantId: string, content: string, attribution: string) {
  const call = await seedInboundCall(pool, tenantId, content);
  await pool.query(
    `INSERT INTO call_facts (tenant_id, message_id, attribution_label) VALUES ($1, $2, $3)`,
    [tenantId, call.id, attribution],
  );
  return call;
}

// ── GET /api/calls/export.csv ───────────────────────────────────────────────

describe('GET /api/calls/export.csv', () => {
  it('returns 401 for unauthenticated request', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/calls/export.csv' });
    expect([401, 403]).toContain(res.statusCode);
  });

  it('returns 403 for non-admin', async () => {
    const { tenantId, headers: adminHeaders } = await adminSession();
    // create a non-admin in the same tenant
    const password = 'pw-99999999';
    await createUser(pool, { tenantId, email: 'user@x.io', password, role: 'tenant_user' });
    const csrf = await csrfFor(app);
    const nonAdminHeaders = await login(app, { email: 'user@x.io', password }, csrf);
    const res = await app.inject({ method: 'GET', url: '/api/calls/export.csv', headers: nonAdminHeaders });
    expect(res.statusCode).toBe(403);
    // suppress unused warning
    void adminHeaders;
  });

  it('returns 200 CSV with correct headers and filtered data', async () => {
    const { tenantId, headers } = await adminSession();
    await seedCallWithAttribution(tenantId, 'Accounts inquiry call', 'Accounts');
    await seedCallWithAttribution(tenantId, 'Maintenance request call', 'Maintenance');

    const res = await app.inject({
      method: 'GET',
      url: '/api/calls/export.csv?attribution=Accounts',
      headers,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');

    const body = res.body;
    const lines = body.split('\n').filter((l: string) => l.trim() !== '');
    expect(lines[0]).toBe('Time,Caller,Phone,Department,Type,Category,Outcome,Sentiment,Duration,Callback,Escalation,Resolution,Summary');
    expect(lines).toHaveLength(2); // header + exactly 1 data row (Accounts only)
  });
});
