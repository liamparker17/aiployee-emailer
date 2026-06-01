import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant, createUser } from './helpers/factories.js';
import { csrfFor, login } from './helpers/auth.js';
import { encrypt } from '../src/crypto/enc.js';

const EMAILER_ENC_KEY = Buffer.alloc(32, 1).toString('base64');

const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY,
  PUBLIC_BASE_URL: 'http://localhost:3000',
  CRON_SECRET: 'c'.repeat(24),
});

const stubLlmFactory = () => ({
  chat: async () => ({ content: 'Hi, I am Abe.', toolCalls: [] }),
});

let app: Awaited<ReturnType<typeof buildApp>>;
const pool = makePool();

beforeAll(async () => {
  app = await buildApp({ cfg, agentLlmFactory: stubLlmFactory });
}, 30000);
beforeEach(async () => { await truncateAll(pool); }, 30000);
afterAll(async () => { await app.close(); await pool.end(); }, 30000);

async function adminSession() {
  const t = await createTenant(pool);
  const password = 'pw-12345678';
  await createUser(pool, { tenantId: t.id, email: 'admin@x.io', password, role: 'tenant_admin' });
  const csrf = await csrfFor(app);
  const headers = await login(app, { email: 'admin@x.io', password }, csrf);

  // Seed agent_configs with an encrypted OpenAI key so runAbeChat doesn't hit the no-key path
  const encKey = Buffer.from(EMAILER_ENC_KEY, 'base64');
  const encryptedKey = encrypt('sk-test', encKey);
  await pool.query(
    `INSERT INTO agent_configs (tenant_id, openai_key_encrypted) VALUES ($1, $2) ON CONFLICT (tenant_id) DO UPDATE SET openai_key_encrypted = $2`,
    [t.id, encryptedKey],
  );

  return { tenantId: t.id, headers, csrf };
}

async function userSession() {
  const t = await createTenant(pool);
  const password = 'pw-12345678';
  await createUser(pool, { tenantId: t.id, email: 'user@x.io', password, role: 'tenant_user' });
  const csrf = await csrfFor(app);
  const headers = await login(app, { email: 'user@x.io', password }, csrf);
  return { tenantId: t.id, headers, csrf };
}

describe('agent chat routes', () => {
  it('GET /api/agent/chat returns empty messages initially', async () => {
    const { headers } = await adminSession();
    const get = await app.inject({ method: 'GET', url: '/api/agent/chat', headers });
    expect(get.statusCode).toBe(200);
    expect(get.json().messages).toEqual([]);
  }, 30000);

  it('POST /api/agent/chat returns reply and GET returns 2 messages', async () => {
    const { headers, csrf } = await adminSession();

    const post = await app.inject({
      method: 'POST', url: '/api/agent/chat',
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
      payload: { message: 'hi' },
    });
    expect(post.statusCode).toBe(200);
    expect(typeof post.json().reply).toBe('string');

    const get = await app.inject({ method: 'GET', url: '/api/agent/chat', headers });
    expect(get.statusCode).toBe(200);
    expect(get.json().messages.length).toBe(2);
  }, 30000);

  it('non-admin POST /api/agent/chat returns 403', async () => {
    const { headers, csrf } = await userSession();

    const post = await app.inject({
      method: 'POST', url: '/api/agent/chat',
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
      payload: { message: 'hi' },
    });
    expect(post.statusCode).toBe(403);
  }, 30000);

  it('non-admin GET /api/agent/chat returns 403', async () => {
    const { headers } = await userSession();
    const get = await app.inject({ method: 'GET', url: '/api/agent/chat', headers });
    expect(get.statusCode).toBe(403);
  }, 30000);
});
