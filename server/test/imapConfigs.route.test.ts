import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '@aiployee/core';
import { makePool, truncateAll } from './helpers/db.js';
import { createUser, createTenant } from './helpers/factories.js';
import { csrfFor, login } from './helpers/auth.js';
import { getImapConfigWithPassword, suggestImapHost } from '@aiployee/core';

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

describe('suggestImapHost', () => {
  it('maps known providers and rewrites smtp. prefixes', () => {
    expect(suggestImapHost('smtp.office365.com')).toBe('outlook.office365.com');
    expect(suggestImapHost('smtp.gmail.com')).toBe('imap.gmail.com');
    expect(suggestImapHost('smtp.example.co.za')).toBe('imap.example.co.za');
    expect(suggestImapHost('mail.example.com')).toBe('mail.example.com');
  });
});

describe('imap configs routes', () => {
  it('enables monitoring by reusing an SMTP credential, with host suggestion', async () => {
    const t = await createTenant(pool);
    const headers = await loginTenantAdmin(t.id);

    const smtp = await app.inject({
      method: 'POST', url: '/api/smtp-configs', headers,
      payload: {
        name: 'M365', host: 'smtp.office365.com', port: 587, secure: false,
        username: 'marcel@mafadiho.co.za', password: 'secret-pass',
        fromDomain: 'mafadiho.co.za', isDefault: true,
      },
    });
    expect(smtp.statusCode).toBe(201);
    const smtpId = smtp.json().config.id as string;

    const create = await app.inject({
      method: 'POST', url: '/api/imap-configs', headers,
      payload: { smtpConfigId: smtpId },
    });
    expect(create.statusCode).toBe(201);
    const c = create.json().config;
    expect(c.host).toBe('outlook.office365.com');
    expect(c.port).toBe(993);
    expect(c.secure).toBe(true);
    expect(c.username).toBe('marcel@mafadiho.co.za');
    expect(c.enabled).toBe(true);

    const stored = await getImapConfigWithPassword(pool, cfg.encKey, c.id);
    expect(stored?.password).toBe('secret-pass');
  });

  it('creates manually, lists per tenant, toggles, and deletes', async () => {
    const a = await createTenant(pool); const b = await createTenant(pool);
    const headersA = await loginTenantAdmin(a.id);

    const create = await app.inject({
      method: 'POST', url: '/api/imap-configs', headers: headersA,
      payload: { host: 'imap.example.com', username: 'u@example.com', password: 'pw 1234' },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().config.id as string;
    // whitespace stripped like SMTP app passwords
    const stored = await getImapConfigWithPassword(pool, cfg.encKey, id);
    expect(stored?.password).toBe('pw1234');

    const list = await app.inject({ method: 'GET', url: '/api/imap-configs', headers: headersA });
    expect(list.json().configs).toHaveLength(1);

    const headersB = await loginTenantAdmin(b.id, 'b@x.com');
    const listB = await app.inject({ method: 'GET', url: '/api/imap-configs', headers: headersB });
    expect(listB.json().configs).toHaveLength(0);

    // cross-tenant patch/delete must 404
    const patchB = await app.inject({
      method: 'PATCH', url: `/api/imap-configs/${id}`, headers: headersB, payload: { enabled: false },
    });
    expect(patchB.statusCode).toBe(404);

    const patch = await app.inject({
      method: 'PATCH', url: `/api/imap-configs/${id}`, headers: headersA, payload: { enabled: false },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().config.enabled).toBe(false);

    const del = await app.inject({ method: 'DELETE', url: `/api/imap-configs/${id}`, headers: headersA });
    expect(del.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/imap-configs', headers: headersA });
    expect(after.json().configs).toHaveLength(0);
  });
});
