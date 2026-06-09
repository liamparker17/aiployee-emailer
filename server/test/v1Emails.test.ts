import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createSmtpConfig } from '../src/repos/smtpConfigs.js';
import { createSender } from '../src/repos/senders.js';
import { insertApiKey } from '../src/repos/apiKeys.js';
import { generateApiKey, hashApiKey, prefixOf } from '../src/auth/apiKey.js';
import { startTestSmtp } from './helpers/smtp.js';
import { getEmail } from '../src/repos/emails.js';

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
  smtp = startTestSmtp(2527);
  app = await buildApp({ cfg });
});
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await smtp.close(); await pool.end(); });

async function setup() {
  const t = await createTenant(pool);
  const sc = await createSmtpConfig(pool, KEY, {
    tenantId: t.id, name: 'local', host: '127.0.0.1', port: 2527, secure: false,
    username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
  });
  const s = await createSender(pool, { tenantId: t.id, email: 'a@x.com', displayName: 'A', smtpConfigId: sc.id });
  const key = generateApiKey();
  await insertApiKey(pool, { tenantId: t.id, name: 'k', keyHash: hashApiKey(key), keyPrefix: prefixOf(key) });
  return { t, s, key };
}

describe('POST /v1/emails', () => {
  it('queues and sends end-to-end', async () => {
    const { t, s, key } = await setup();
    const recv = smtp.lastMail();
    const r = await app.inject({
      method: 'POST', url: '/v1/emails',
      headers: { authorization: `Bearer ${key}` },
      payload: { from: s.email, to: 'r@x.com', subject: 'Hi', html: '<p>x</p>' },
    });
    expect(r.statusCode).toBe(202);
    const body = r.json() as { id: string; status: string };
    // Inline dispatch: immediate sends return 'sent' synchronously (no queue wait).
    expect(body.status).toBe('sent');
    const mail = await recv as { headers: Record<string, string> };
    expect(mail.headers.subject).toContain('Hi');
    const after = await getEmail(pool, t.id, body.id);
    expect(after!.status).toBe('sent');
  });

  it('rejects without bearer', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/emails', payload: {} });
    expect(r.statusCode).toBe(401);
  });

  it('authenticates a sub-key as the tenant', async () => {
    const t = await createTenant(pool);
    const sc = await createSmtpConfig(pool, KEY, {
      tenantId: t.id, name: 'local', host: '127.0.0.1', port: 2527, secure: false,
      username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
    });
    const s = await createSender(pool, { tenantId: t.id, email: 'a@x.com', displayName: 'A', smtpConfigId: sc.id });
    const masterPlain = generateApiKey();
    const master = await insertApiKey(pool, { tenantId: t.id, name: 'master', keyHash: hashApiKey(masterPlain), keyPrefix: prefixOf(masterPlain) });
    const subPlain = generateApiKey();
    await insertApiKey(pool, { tenantId: t.id, name: 'sub', keyHash: hashApiKey(subPlain), keyPrefix: prefixOf(subPlain), parentId: master.id });

    const recv = smtp.lastMail();
    const r = await app.inject({
      method: 'POST', url: '/v1/emails',
      headers: { authorization: `Bearer ${subPlain}` },
      payload: { from: s.email, to: 'r@x.com', subject: 'Sub', html: '<p>x</p>' },
    });
    expect(r.statusCode).toBe(202);
    expect((r.json() as { status: string }).status).toBe('sent');
    await recv;
  });
});
