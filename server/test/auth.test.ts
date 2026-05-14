import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createUser } from './helpers/factories.js';

const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
});
let app: Awaited<ReturnType<typeof buildApp>>;
const pool = makePool();

beforeAll(async () => { app = await buildApp({ cfg }); });
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await pool.end(); });

async function csrfHeaders() {
  const g = await app.inject({ method: 'GET', url: '/healthz' });
  const setCookie = g.headers['set-cookie'] as string | string[];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const csrf = cookies.find(c => c.startsWith('aip_csrf='))!.split(';')[0];
  const sid  = cookies.find(c => c.startsWith('aip_sid='))!.split(';')[0];
  const csrfVal = decodeURIComponent(csrf.split('=')[1]);
  return { cookie: `${sid}; ${csrf}`, 'x-csrf-token': csrfVal };
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
