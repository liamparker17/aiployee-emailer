import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '@aiployee/core';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant, createUser } from './helpers/factories.js';
import { csrfFor, login } from './helpers/auth.js';
import { createSmtpConfig } from '@aiployee/core';
import { createSender } from '@aiployee/core';
import { listEmails } from '@aiployee/core';

const KEY = Buffer.alloc(32, 1);
const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32), EMAILER_ENC_KEY: KEY.toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000', CRON_SECRET: 'c'.repeat(24),
});
let app: Awaited<ReturnType<typeof buildApp>>;
const pool = makePool();
beforeAll(async () => { app = await buildApp({ cfg }); });
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await pool.end(); });

describe('POST /api/campaigns/launch', () => {
  it('imports recipients, creates a list + campaign, and queues sends', async () => {
    const t = await createTenant(pool);
    await createUser(pool, { tenantId: t.id, email: 'a@x.com', password: 'pw12345678', role: 'tenant_admin' });
    const sc = await createSmtpConfig(pool, KEY, { tenantId: t.id, name: 'l', host: 'h', port: 587, secure: false, username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true });
    const s = await createSender(pool, { tenantId: t.id, email: 'a@x.com', displayName: 'A', smtpConfigId: sc.id });
    const csrf = await csrfFor(app);
    const headers = await login(app, { email: 'a@x.com', password: 'pw12345678' }, csrf);

    const r = await app.inject({
      method: 'POST', url: '/api/campaigns/launch', headers,
      payload: {
        name: 'Promo', senderId: s.id, subject: 'Hi {{name}}', bodyHtml: '<p>Hello {{name}}</p>',
        contacts: [{ email: 'one@x.com', name: 'One' }, { email: 'two@x.com', name: 'Two' }],
      },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.imported).toBe(2);
    expect(body.queued).toBe(2);
    expect(body.campaignId).toBeTruthy();

    const emails = await listEmails(pool, t.id, {});
    expect(emails).toHaveLength(2);
    expect(emails.every(e => e.body_html.includes('/v1/unsubscribe/'))).toBe(true);
  });
});
