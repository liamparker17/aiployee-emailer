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

async function loginTenantAdmin(tenantId: string, email = 'a@x.com') {
  await createUser(pool, { tenantId, email, password: 'pw12345!', role: 'tenant_admin' });
  const g = await app.inject({ method: 'GET', url: '/healthz' });
  const cookies = ([] as string[]).concat(g.headers['set-cookie'] as string | string[]);
  const csrf = cookies.find(c => c.startsWith('aip_csrf='))!.split(';')[0];
  const sid  = cookies.find(c => c.startsWith('aip_sid='))!.split(';')[0];
  const csrfVal = decodeURIComponent(csrf.split('=')[1]);
  const headers = { cookie: `${sid}; ${csrf}`, 'x-csrf-token': csrfVal };
  await app.inject({ method: 'POST', url: '/auth/login', headers, payload: { email, password: 'pw12345!' } });
  return headers;
}

describe('smtp configs routes', () => {
  it('creates, lists, and isolates by tenant', async () => {
    const a = await createTenant(pool); const b = await createTenant(pool);
    const headersA = await loginTenantAdmin(a.id);
    const create = await app.inject({
      method: 'POST', url: '/api/smtp-configs', headers: headersA,
      payload: { name: 'SES', host: 'h', port: 587, secure: false, username: 'u', password: 'p', fromDomain: 'a.com', isDefault: true },
    });
    expect(create.statusCode).toBe(201);

    const list = await app.inject({ method: 'GET', url: '/api/smtp-configs', headers: headersA });
    expect(list.json().configs).toHaveLength(1);

    const headersB = await loginTenantAdmin(b.id, 'b@x.com');
    const listB = await app.inject({ method: 'GET', url: '/api/smtp-configs', headers: headersB });
    expect(listB.json().configs).toHaveLength(0);
  });
});
