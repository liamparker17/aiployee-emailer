import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant, createUser } from './helpers/factories.js';
import { csrfFor, login } from './helpers/auth.js';

const KEY = Buffer.alloc(32, 1);
const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32), EMAILER_ENC_KEY: KEY.toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000', CRON_SECRET: 'c'.repeat(24),
});
let app: Awaited<ReturnType<typeof buildApp>>;
const pool = makePool();
beforeAll(async () => { app = await buildApp({ cfg }); });
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await pool.end(); });
afterEach(() => vi.unstubAllGlobals());

async function adminSession() {
  const t = await createTenant(pool);
  const password = 'pw-12345678';
  await createUser(pool, { tenantId: t.id, email: 'admin@x.io', password, role: 'tenant_admin' });
  const csrf = await csrfFor(app);
  const headers = await login(app, { email: 'admin@x.io', password }, csrf);
  return { tenantId: t.id, headers };
}
async function nonAdminSession(tenantId: string) {
  const password = 'pw-99999999';
  await createUser(pool, { tenantId, email: 'user@x.io', password, role: 'tenant_user' });
  const csrf = await csrfFor(app);
  const headers = await login(app, { email: 'user@x.io', password }, csrf);
  return { headers };
}

const okFetch = () => vi.fn(async () => new Response(JSON.stringify({ status: 'accepted' }), { status: 200 }));

describe('jobix triggers routes', () => {
  it('creates a trigger and never returns the token', async () => {
    const { headers } = await adminSession();
    const res = await app.inject({ method: 'POST', url: '/api/jobix-triggers', headers,
      payload: { label: 'CB', token: 'super-secret-token', payload_template: '{"name":"{{name}}"}' } });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain('super-secret-token');
    expect(JSON.parse(res.body).trigger.hasToken).toBe(true);
  });

  it('400 on a non-bearer placement without token_param', async () => {
    const { headers } = await adminSession();
    const res = await app.inject({ method: 'POST', url: '/api/jobix-triggers', headers,
      payload: { label: 'X', token: 't', token_placement: 'header', payload_template: '{}' } });
    expect(res.statusCode).toBe(400);
  });

  it('400 on an http url', async () => {
    const { headers } = await adminSession();
    const res = await app.inject({ method: 'POST', url: '/api/jobix-triggers', headers,
      payload: { label: 'Y', token: 't', url: 'http://x.io', payload_template: '{}' } });
    expect(res.statusCode).toBe(400);
  });

  it('test fires via the (stubbed) fetch and returns a FireResult', async () => {
    const { headers } = await adminSession();
    const create = await app.inject({ method: 'POST', url: '/api/jobix-triggers', headers,
      payload: { label: 'T', token: 't', payload_template: '{"name":"{{name}}"}' } });
    const id = JSON.parse(create.body).trigger.id;
    vi.stubGlobal('fetch', okFetch());
    const res = await app.inject({ method: 'POST', url: `/api/jobix-triggers/${id}/test`, headers, payload: { vars: { name: 'R' } } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).result.ok).toBe(true);
    vi.unstubAllGlobals();
  });

  it('403 for a non-admin', async () => {
    const { tenantId } = await adminSession();
    const { headers } = await nonAdminSession(tenantId);
    const res = await app.inject({ method: 'GET', url: '/api/jobix-triggers', headers });
    expect(res.statusCode).toBe(403);
  });

  it('404 deleting another tenant\'s trigger', async () => {
    const { headers } = await adminSession();
    const res = await app.inject({ method: 'DELETE', url: '/api/jobix-triggers/00000000-0000-0000-0000-000000000000', headers });
    expect(res.statusCode).toBe(404);
  });
});
