import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '@aiployee/core';
import { makePool, truncateAll } from './helpers/db.js';
import { createUser, createTenant } from './helpers/factories.js';
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

async function loginTenantAdmin(tenantId: string) {
  await createUser(pool, { tenantId, email: 'a@x.com', password: 'pw12345!', role: 'tenant_admin' });
  const csrf = await csrfFor(app);
  return login(app, { email: 'a@x.com', password: 'pw12345!' }, csrf);
}

describe('suppressions routes', () => {
  it('creates, lists, removes', async () => {
    const t = await createTenant(pool);
    const headers = await loginTenantAdmin(t.id);
    const c = await app.inject({ method: 'POST', url: '/api/suppressions', headers, payload: { address: 'r@x.com' } });
    expect(c.statusCode).toBe(201);
    const l = await app.inject({ method: 'GET', url: '/api/suppressions', headers });
    expect((l.json() as { suppressions: unknown[] }).suppressions).toHaveLength(1);
    const d = await app.inject({ method: 'DELETE', url: '/api/suppressions/r%40x.com', headers });
    expect(d.statusCode).toBe(200);
  });
});
