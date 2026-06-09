import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant, createUser } from './helpers/factories.js';
import { csrfFor, login } from './helpers/auth.js';
import { createSmtpConfig } from '../src/repos/smtpConfigs.js';
import { createSender } from '../src/repos/senders.js';
import { createTemplate } from '../src/repos/templates.js';
import { startTestSmtp } from './helpers/smtp.js';

const KEY = Buffer.alloc(32, 1);
const SMTP_PORT = 2529;
const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: KEY.toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
  CRON_SECRET: 'c'.repeat(24),
});

let app: Awaited<ReturnType<typeof buildApp>>;
let smtp: ReturnType<typeof startTestSmtp>;
const pool = makePool();

beforeAll(async () => {
  smtp = startTestSmtp(SMTP_PORT);
  app = await buildApp({ cfg });
});
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await smtp.close(); await pool.end(); });

/** Admin session for a tenant that HAS a default sender + the greet template. */
async function adminWithSender() {
  const t = await createTenant(pool);
  const sc = await createSmtpConfig(pool, KEY, {
    tenantId: t.id, name: 'local', host: '127.0.0.1', port: SMTP_PORT, secure: false,
    username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
  });
  await createSender(pool, {
    tenantId: t.id, email: 'a@x.com', displayName: 'A', smtpConfigId: sc.id, isDefault: true,
  });
  const tpl = await createTemplate(pool, {
    tenantId: t.id, name: 'greet', subject: 'Hi {{name}}',
    bodyHtml: '<p>Hello {{name}}</p>', bodyText: null,
  });
  const password = 'pw-12345678';
  await createUser(pool, { tenantId: t.id, email: 'admin@x.io', password, role: 'tenant_admin' });
  const csrf = await csrfFor(app);
  const headers = await login(app, { email: 'admin@x.io', password }, csrf);
  return { tenantId: t.id, headers, tpl };
}

async function nonAdminSession(tenantId: string) {
  const password = 'pw-99999999';
  await createUser(pool, { tenantId, email: 'user@x.io', password, role: 'tenant_user' });
  const csrf = await csrfFor(app);
  const headers = await login(app, { email: 'user@x.io', password }, csrf);
  return { headers };
}

describe('POST /api/templates/:id/test-send', () => {
  it('admin sends with filled variable → 200 ok, smtp captures Hi Liam', async () => {
    const { headers, tpl } = await adminWithSender();
    const recv = smtp.lastMail();
    const res = await app.inject({
      method: 'POST', url: `/api/templates/${tpl.id}/test-send`,
      headers, payload: { to: 'me@x.com', variables: { name: 'Liam' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    const mail = await recv as { headers: Record<string, string> };
    expect(mail.headers.subject).toContain('Hi Liam');
  });

  it('unfilled variable renders the variable name as sample', async () => {
    const { headers, tpl } = await adminWithSender();
    const recv = smtp.lastMail();
    const res = await app.inject({
      method: 'POST', url: `/api/templates/${tpl.id}/test-send`,
      headers, payload: { to: 'me@x.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    const mail = await recv as { headers: Record<string, string> };
    expect(mail.headers.subject).toContain('Hi name');
  });

  it('400 when tenant has no default sender', async () => {
    const t = await createTenant(pool);
    const tpl = await createTemplate(pool, {
      tenantId: t.id, name: 'greet', subject: 'Hi {{name}}',
      bodyHtml: '<p>Hello {{name}}</p>', bodyText: null,
    });
    const password = 'pw-12345678';
    await createUser(pool, { tenantId: t.id, email: 'admin@x.io', password, role: 'tenant_admin' });
    const csrf = await csrfFor(app);
    const headers = await login(app, { email: 'admin@x.io', password }, csrf);
    const res = await app.inject({
      method: 'POST', url: `/api/templates/${tpl.id}/test-send`,
      headers, payload: { to: 'me@x.com', variables: { name: 'Liam' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('403 for non-admin session', async () => {
    const { tenantId, tpl } = await adminWithSender();
    const { headers } = await nonAdminSession(tenantId);
    const res = await app.inject({
      method: 'POST', url: `/api/templates/${tpl.id}/test-send`,
      headers, payload: { to: 'me@x.com', variables: { name: 'Liam' } },
    });
    expect(res.statusCode).toBe(403);
  });

  it('404 for unknown template id', async () => {
    const { headers } = await adminWithSender();
    const res = await app.inject({
      method: 'POST', url: `/api/templates/00000000-0000-0000-0000-000000000000/test-send`,
      headers, payload: { to: 'me@x.com', variables: { name: 'Liam' } },
    });
    expect(res.statusCode).toBe(404);
  });
});
