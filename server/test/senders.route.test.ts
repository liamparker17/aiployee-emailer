import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '@aiployee/core';
import { makePool, truncateAll } from './helpers/db.js';
import { createUser, createTenant } from './helpers/factories.js';
import { createSmtpConfig } from '@aiployee/core';
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

async function loginTenantAdmin(tenantId: string, email = 'a@x.com') {
  await createUser(pool, { tenantId, email, password: 'pw12345!', role: 'tenant_admin' });
  const csrf = await csrfFor(app);
  return login(app, { email, password: 'pw12345!' }, csrf);
}

describe('senders routes', () => {
  it('creates a sender bound to an SMTP config', async () => {
    const t = await createTenant(pool);
    const headers = await loginTenantAdmin(t.id);
    const sc = await createSmtpConfig(pool, cfg.encKey, {
      tenantId: t.id, name: 'SES', host: 'h', port: 587, secure: false,
      username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
    });
    const r = await app.inject({
      method: 'POST', url: '/api/senders', headers,
      payload: { email: 'alex@x.com', displayName: 'Alex', smtpConfigId: sc.id },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().sender.email).toBe('alex@x.com');
  });

  it('rejects sender bound to another tenant SMTP config', async () => {
    const a = await createTenant(pool); const b = await createTenant(pool);
    const headersA = await loginTenantAdmin(a.id);
    const scB = await createSmtpConfig(pool, cfg.encKey, {
      tenantId: b.id, name: 'SES', host: 'h', port: 587, secure: false,
      username: 'u', password: 'p', fromDomain: 'b.com', isDefault: true,
    });
    const r = await app.inject({
      method: 'POST', url: '/api/senders', headers: headersA,
      payload: { email: 'x@b.com', displayName: 'X', smtpConfigId: scB.id },
    });
    expect(r.statusCode).toBe(400);
  });
});
