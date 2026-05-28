import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant, createUser } from './helpers/factories.js';
import { csrfFor, login } from './helpers/auth.js';

const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
  CRON_SECRET: 'c'.repeat(24),
});
let app: Awaited<ReturnType<typeof buildApp>>;
const pool = makePool();

beforeAll(async () => { app = await buildApp({ cfg }); });
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await pool.end(); });

async function loginAs(email: string, password: string) {
  const csrf = await csrfFor(app);
  return login(app, { email, password }, csrf);
}

describe('POST /api/session/active-tenant', () => {
  it('super-admin sets active tenant and tenant-scoped routes work', async () => {
    const tenant = await createTenant(pool, 'Acme');
    await createUser(pool, { tenantId: null, email: 'admin@example.com', password: 'pw12345678', role: 'super_admin' });
    const headers = await loginAs('admin@example.com', 'pw12345678');
    const r = await app.inject({
      method: 'POST', url: '/api/session/active-tenant',
      headers, payload: { tenantId: tenant.id },
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, tenantId: tenant.id });
    // Confirm context flips by hitting a tenant-scoped GET.
    const senders = await app.inject({ method: 'GET', url: '/api/senders', headers });
    expect(senders.statusCode).toBe(200);
  });

  it('rejects unknown tenant id with 404', async () => {
    await createUser(pool, { tenantId: null, email: 'admin@example.com', password: 'pw12345678', role: 'super_admin' });
    const headers = await loginAs('admin@example.com', 'pw12345678');
    const r = await app.inject({
      method: 'POST', url: '/api/session/active-tenant',
      headers, payload: { tenantId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(r.statusCode).toBe(404);
  });

  it('returns 403 for non-super-admin', async () => {
    const t = await createTenant(pool, 'Acme2');
    await createUser(pool, { tenantId: t.id, email: 'user@example.com', password: 'pw12345678', role: 'tenant_admin' });
    const headers = await loginAs('user@example.com', 'pw12345678');
    const r = await app.inject({
      method: 'POST', url: '/api/session/active-tenant',
      headers, payload: { tenantId: t.id },
    });
    expect(r.statusCode).toBe(403);
  });

  it('blocks tenant-scoped routes when super-admin has no active tenant', async () => {
    await createUser(pool, { tenantId: null, email: 'admin@example.com', password: 'pw12345678', role: 'super_admin' });
    const headers = await loginAs('admin@example.com', 'pw12345678');
    const r = await app.inject({ method: 'GET', url: '/api/senders', headers });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error.code).toBe('no_active_tenant');
  });
});
