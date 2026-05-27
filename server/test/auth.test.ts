import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createUser } from './helpers/factories.js';
import { csrfFor } from './helpers/auth.js';

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

async function csrfHeaders() {
  const csrf = await csrfFor(app);
  return { cookie: csrf.cookie, 'x-csrf-token': csrf.csrfToken };
}

describe('auth', () => {
  it('logs in valid super_admin', async () => {
    await createUser(pool, { tenantId: null, email: 'root@x.com', password: 'pw12345!', role: 'super_admin' });
    const headers = await csrfHeaders();
    const r = await app.inject({
      method: 'POST', url: '/auth/login', headers,
      payload: { email: 'root@x.com', password: 'pw12345!' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ user: { email: 'root@x.com', role: 'super_admin' } });
  });

  it('rejects bad password', async () => {
    await createUser(pool, { tenantId: null, email: 'root@x.com', password: 'pw12345!', role: 'super_admin' });
    const headers = await csrfHeaders();
    const r = await app.inject({
      method: 'POST', url: '/auth/login', headers,
      payload: { email: 'root@x.com', password: 'wrong' },
    });
    expect(r.statusCode).toBe(401);
  });
});
