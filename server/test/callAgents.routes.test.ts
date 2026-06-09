import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
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

describe('call agents routes', () => {
  it('creates an agent and never returns the company_key', async () => {
    const { headers } = await adminSession();
    const res = await app.inject({ method: 'POST', url: '/api/calls/agents', headers,
      payload: { label: 'Arrears', company_key: 'super-secret', values_schema: [{ key: 'unit_number', label: 'Unit', required: true }] } });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain('super-secret');
    const body = JSON.parse(res.body);
    expect(body.agent.hasKey).toBe(true);
    expect(body.agent).not.toHaveProperty('company_key');
  });

  it('403 for a non-admin', async () => {
    const { tenantId } = await adminSession();
    const { headers } = await nonAdminSession(tenantId);
    const res = await app.inject({ method: 'GET', url: '/api/calls/agents', headers });
    expect(res.statusCode).toBe(403);
  });

  it('404 patching another tenant\'s agent', async () => {
    const { headers } = await adminSession();
    const res = await app.inject({ method: 'PATCH', url: '/api/calls/agents/00000000-0000-0000-0000-000000000000', headers, payload: { label: 'x' } });
    expect(res.statusCode).toBe(404);
  });
});
