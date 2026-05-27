import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createUser } from './helpers/factories.js';
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

describe('admin tenants', () => {
  it('super_admin creates a tenant + invites first admin', async () => {
    await createUser(pool, { tenantId: null, email: 'root@x.com', password: 'pw12345!', role: 'super_admin' });
    const headers = await loginAs('root@x.com', 'pw12345!');
    const create = await app.inject({
      method: 'POST', url: '/api/admin/tenants', headers,
      payload: { name: 'Acme', slug: 'acme', adminEmail: 'admin@acme.com' },
    });
    expect(create.statusCode).toBe(201);
    const body = create.json();
    expect(body.tenant.slug).toBe('acme');
    expect(body.invite.token).toBeTruthy();
  });

  it('non-super-admin gets 403', async () => {
    const t = await pool.query(`INSERT INTO tenants(name,slug) VALUES ('A','a') RETURNING id`);
    await createUser(pool, { tenantId: t.rows[0].id, email: 'u@a.com', password: 'pw12345!', role: 'tenant_admin' });
    const headers = await loginAs('u@a.com', 'pw12345!');
    const create = await app.inject({
      method: 'POST', url: '/api/admin/tenants', headers,
      payload: { name: 'B', slug: 'b', adminEmail: 'x@b.com' },
    });
    expect(create.statusCode).toBe(403);
  });
});
