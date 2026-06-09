import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '@aiployee/core';
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

async function adminSession() {
  const t = await createTenant(pool);
  const password = 'pw-12345678';
  await createUser(pool, { tenantId: t.id, email: 'admin@x.io', password, role: 'tenant_admin' });
  const csrf = await csrfFor(app);
  const headers = await login(app, { email: 'admin@x.io', password }, csrf);
  return { tenantId: t.id, headers, csrf };
}

describe('abe routes', () => {
  it('PUT then GET goal round-trips and defaults auto-fire to 0', async () => {
    const { headers, csrf } = await adminSession();
    const put = await app.inject({
      method: 'PUT', url: '/api/agent/goals', headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
      payload: { enabled: true, dormantWindowDays: 45, lineManagerEmail: 'boss@x.io' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().goal.auto_fire_max_audience).toBe(0);

    const get = await app.inject({ method: 'GET', url: '/api/agent/goals', headers });
    expect(get.json().goal.dormant_window_days).toBe(45);
  });

  it('GET /api/agent/plays returns an array', async () => {
    const { headers } = await adminSession();
    const get = await app.inject({ method: 'GET', url: '/api/agent/plays', headers });
    expect(get.statusCode).toBe(200);
    expect(Array.isArray(get.json().plays)).toBe(true);
  });
});
