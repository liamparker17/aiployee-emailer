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
import { upsertLineReportConfig } from '../src/repos/lineReportConfigs.js';
import { listCalls } from '../src/repos/callAnalytics.js';

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
  const s = await createSender(pool, { tenantId: t.id, email: 'a@x.com', displayName: 'A', smtpConfigId: sc.id });
  const key = generateApiKey();
  await insertApiKey(pool, { tenantId: t.id, name: 'k', keyHash: hashApiKey(key), keyPrefix: prefixOf(key) });
  return { t, s, key };
}

async function send(key: string, from: string, payload: Record<string, unknown>) {
  const recv = smtp.lastMail();
  const r = await app.inject({
    method: 'POST', url: '/v1/emails',
    headers: { authorization: `Bearer ${key}` },
    payload: { from, to: 'r@x.com', ...payload },
  });
  await recv;
  return r;
}

describe('POST /v1/emails — opt-in call capture', () => {
  it('does NOT mirror a call when ingest_sends_as_calls is off (default)', async () => {
    const { t, s, key } = await setup();
    const r = await send(key, s.email, { subject: 'Hi', html: '<p>x</p>' });
    expect(r.statusCode).toBe(202);
    const { total } = await listCalls(pool, t.id, {});
    expect(total).toBe(0);
  });

  it('mirrors a raw send into one inbound call when the flag is on', async () => {
    const { t, s, key } = await setup();
    await upsertLineReportConfig(pool, t.id, { ingestSendsAsCalls: true });
    const r = await send(key, s.email, { subject: 'Card dispute', html: '<p>Customer reported fraud on card</p>' });
    expect(r.statusCode).toBe(202);
    const { total, calls } = await listCalls(pool, t.id, {});
    expect(total).toBe(1);
    expect(calls[0].content).toContain('Customer reported fraud on card');
  });

  it('prefers variables.summary for template sends when the flag is on', async () => {
    const { t, s, key } = await setup();
    await upsertLineReportConfig(pool, t.id, { ingestSendsAsCalls: true });
    const r = await send(key, s.email, {
      subject: 'Other subject', html: '<p>Other body</p>',
      variables: { summary: 'Caller asked about debit order reversal' },
    });
    expect(r.statusCode).toBe(202);
    const { total, calls } = await listCalls(pool, t.id, {});
    expect(total).toBe(1);
    expect(calls[0].content).toBe('Caller asked about debit order reversal');
  });
});
