import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '@aiployee/core';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createSmtpConfig } from '@aiployee/core';
import { createSender } from '@aiployee/core';
import { createTemplate } from '@aiployee/core';
import { insertApiKey } from '@aiployee/core';
import { generateApiKey, hashApiKey, prefixOf } from '@aiployee/core';
import { startTestSmtp } from './helpers/smtp.js';

const KEY = Buffer.alloc(32, 1);
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
  smtp = startTestSmtp(2528);
  app = await buildApp({ cfg });
});
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await smtp.close(); await pool.end(); });

async function setup() {
  const t = await createTenant(pool);
  const sc = await createSmtpConfig(pool, KEY, {
    tenantId: t.id, name: 'local', host: '127.0.0.1', port: 2528, secure: false,
    username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
  });
  const s = await createSender(pool, { tenantId: t.id, email: 'a@x.com', displayName: 'Sender Co', smtpConfigId: sc.id });
  const key = generateApiKey();
  await insertApiKey(pool, { tenantId: t.id, name: 'k', keyHash: hashApiKey(key), keyPrefix: prefixOf(key) });
  return { t, s, key };
}

describe('per-template From display name', () => {
  it('uses the template display name on the From header', async () => {
    const { t, s, key } = await setup();
    await createTemplate(pool, {
      tenantId: t.id, name: 'absa', subject: 'Hi {{x}}', bodyHtml: '<p>{{x}}</p>', displayName: 'Absa Line',
    });
    const recv = smtp.lastMail();
    const r = await app.inject({
      method: 'POST', url: '/v1/emails',
      headers: { authorization: `Bearer ${key}` },
      payload: { from: s.email, to: 'r@x.com', template: 'absa', variables: { x: '1' } },
    });
    expect(r.statusCode).toBe(202);
    const mail = await recv as { headers: Record<string, string> };
    expect(mail.headers.from).toContain('Absa Line');
  });

  it('falls back to the sender display name when no template', async () => {
    const { s, key } = await setup();
    const recv = smtp.lastMail();
    const r = await app.inject({
      method: 'POST', url: '/v1/emails',
      headers: { authorization: `Bearer ${key}` },
      payload: { from: s.email, to: 'r@x.com', subject: 'Raw', html: '<p>hi</p>' },
    });
    expect(r.statusCode).toBe(202);
    const mail = await recv as { headers: Record<string, string> };
    expect(mail.headers.from).toContain('Sender Co');
    expect(mail.headers.from).not.toContain('Absa Line');
  });
});
