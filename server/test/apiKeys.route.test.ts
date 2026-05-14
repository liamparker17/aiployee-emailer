import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createUser, createTenant } from './helpers/factories.js';

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

async function loginTenantAdmin(tenantId: string) {
  await createUser(pool, { tenantId, email: 'a@x.com', password: 'pw12345!', role: 'tenant_admin' });
  const g = await app.inject({ method: 'GET', url: '/healthz' });
  const cookies = ([] as string[]).concat(g.headers['set-cookie'] as string | string[]);
  const csrf = cookies.find(c => c.startsWith('aip_csrf='))!.split(';')[0];
  const sid  = cookies.find(c => c.startsWith('aip_sid='))!.split(';')[0];
  const csrfVal = decodeURIComponent(csrf.split('=')[1]);
  const headers = { cookie: `${sid}; ${csrf}`, 'x-csrf-token': csrfVal };
  await app.inject({ method: 'POST', url: '/auth/login', headers, payload: { email: 'a@x.com', password: 'pw12345!' } });
  return headers;
}

describe('api keys routes', () => {
  it('creates, lists (no plaintext), and revokes', async () => {
    const t = await createTenant(pool);
    const headers = await loginTenantAdmin(t.id);
    const create = await app.inject({
      method: 'POST', url: '/api/api-keys', headers, payload: { name: 'workflow-1' },
    });
    expect(create.statusCode).toBe(201);
    const body = create.json();
    expect(body.plaintext.startsWith('aip_live_')).toBe(true);
    expect(body.key.key_prefix).toBe(body.plaintext.slice(0, 13));

    const list = await app.inject({ method: 'GET', url: '/api/api-keys', headers });
    expect(list.json().keys[0]).not.toHaveProperty('key_hash');

    const id = body.key.id;
    const del = await app.inject({ method: 'DELETE', url: `/api/api-keys/${id}`, headers });
    expect(del.statusCode).toBe(200);
    const list2 = await app.inject({ method: 'GET', url: '/api/api-keys', headers });
    expect(list2.json().keys[0].revoked_at).toBeTruthy();
  });
});
