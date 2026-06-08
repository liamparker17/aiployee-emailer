import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '@aiployee/core';
import { makePool, truncateAll } from './helpers/db.js';
import { createUser, createTenant } from './helpers/factories.js';
import { csrfFor, login } from './helpers/auth.js';
import { getSmtpConfigWithPassword } from '../src/repos/smtpConfigs.js';

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

async function loginTenantAdmin(tenantId: string, email = 'a@x.com') {
  await createUser(pool, { tenantId, email, password: 'pw12345!', role: 'tenant_admin' });
  const csrf = await csrfFor(app);
  return login(app, { email, password: 'pw12345!' }, csrf);
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

  it('strips whitespace from pasted Gmail-style app passwords', async () => {
    const t = await createTenant(pool);
    const headers = await loginTenantAdmin(t.id);
    const create = await app.inject({
      method: 'POST', url: '/api/smtp-configs', headers,
      payload: {
        name: 'Gmail', host: 'smtp.gmail.com', port: 465, secure: true,
        username: 'liam@gmail.com', password: 'abcd efgh ijkl mnop',
        fromDomain: 'gmail.com', isDefault: true,
      },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().config.id as string;
    const stored = await getSmtpConfigWithPassword(pool, cfg.encKey, t.id, id);
    expect(stored?.password).toBe('abcdefghijklmnop');
  });
});
