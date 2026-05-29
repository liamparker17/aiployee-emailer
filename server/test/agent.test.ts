import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant, createUser } from './helpers/factories.js';
import { csrfFor, login } from './helpers/auth.js';
import { insertApiKey } from '../src/repos/apiKeys.js';
import { generateApiKey, hashApiKey, prefixOf } from '../src/auth/apiKey.js';

const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
  CRON_SECRET: 'c'.repeat(24),
});

// Stub LLM so no real OpenAI call happens. Echoes a fixed reply.
const stubFactory = () => ({ respond: async () => 'STUB REPLY' });

let app: Awaited<ReturnType<typeof buildApp>>;
const pool = makePool();
beforeAll(async () => { app = await buildApp({ cfg, agentLlmFactory: stubFactory }); });
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await pool.end(); });

async function loginAs(email: string, password: string) {
  const csrf = await csrfFor(app);
  return login(app, { email, password }, csrf);
}

/** Set up a tenant with an admin (session) and an API key (Jobix ingest). */
async function setup(opts: { autoApprove?: boolean; enabled?: boolean } = {}) {
  const t = await createTenant(pool);
  await createUser(pool, { tenantId: t.id, email: 'admin@x.com', password: 'pw12345678', role: 'tenant_admin' });
  const headers = await loginAs('admin@x.com', 'pw12345678');
  const key = generateApiKey();
  await insertApiKey(pool, { tenantId: t.id, name: 'k', keyHash: hashApiKey(key), keyPrefix: prefixOf(key) });
  if (opts.enabled !== false) {
    await app.inject({
      method: 'PUT', url: '/api/agent/config', headers,
      payload: { enabled: true, model: 'gpt-4o', systemPrompt: '', autoApproveJobix: opts.autoApprove ?? true, maxToolIterations: 4, openaiKey: 'sk-test' },
    });
  }
  return { t, headers, key };
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

describe('agent config', () => {
  it('PUT then GET returns config with has_key, no plaintext', async () => {
    const { headers } = await setup();
    const get = await app.inject({ method: 'GET', url: '/api/agent/config', headers });
    expect(get.statusCode).toBe(200);
    expect(get.json().config.enabled).toBe(true);
    expect(get.json().config.has_key).toBe(true);
    expect(get.json().config).not.toHaveProperty('openai_key_encrypted');
  });

  it('config requires admin (tenant_user gets 403)', async () => {
    const t = await createTenant(pool);
    await createUser(pool, { tenantId: t.id, email: 'u@x.com', password: 'pw12345678', role: 'tenant_user' });
    const headers = await loginAs('u@x.com', 'pw12345678');
    const r = await app.inject({ method: 'GET', url: '/api/agent/config', headers });
    expect(r.statusCode).toBe(403);
  });
});

describe('POST /v1/agent/messages', () => {
  it('rejects when the agent is disabled', async () => {
    const { key } = await setup({ enabled: false });
    const r = await app.inject({ method: 'POST', url: '/v1/agent/messages', headers: bearer(key), payload: { thread_ref: 't1', message: 'hi' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('agent_disabled');
  });

  it('requires an API key (no bearer = 401)', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/agent/messages', payload: { thread_ref: 't1', message: 'hi' } });
    expect(r.statusCode).toBe(401);
  });

  it('auto-approves a Jobix message and returns the reply', async () => {
    const { key, headers } = await setup({ autoApprove: true });
    const r = await app.inject({ method: 'POST', url: '/v1/agent/messages', headers: bearer(key), payload: { thread_ref: 't1', message: 'Reply to the customer' } });
    expect(r.statusCode).toBe(202);
    expect(r.json().status).toBe('sent');
    expect(r.json().response_text).toBe('STUB REPLY');

    // The thread now has the inbound + an approved agent message.
    const threads = (await app.inject({ method: 'GET', url: '/api/agent/threads', headers })).json().threads;
    expect(threads).toHaveLength(1);
    const detail = (await app.inject({ method: 'GET', url: `/api/agent/threads/${threads[0].id}`, headers })).json();
    expect(detail.messages.map((m: { role: string }) => m.role)).toEqual(['inbound', 'agent']);
    const agentMsg = detail.messages.find((m: { role: string }) => m.role === 'agent');
    expect(agentMsg.status).toBe('approved');
  });

  it('is idempotent on message_ref', async () => {
    const { key, headers } = await setup();
    const p = { thread_ref: 't1', message: 'hi', message_ref: 'jobix-msg-1' };
    const a = await app.inject({ method: 'POST', url: '/v1/agent/messages', headers: bearer(key), payload: p });
    const b = await app.inject({ method: 'POST', url: '/v1/agent/messages', headers: bearer(key), payload: p });
    expect(a.statusCode).toBe(202);
    expect(b.json().duplicate).toBe(true);
    // Only one inbound message stored for that ref → thread has inbound + agent (2), not 3.
    const threads = (await app.inject({ method: 'GET', url: '/api/agent/threads', headers })).json().threads;
    const detail = (await app.inject({ method: 'GET', url: `/api/agent/threads/${threads[0].id}`, headers })).json();
    expect(detail.messages.filter((m: { role: string }) => m.role === 'inbound')).toHaveLength(1);
  });

  it('drafts for approval when auto-approve is off, then approves', async () => {
    const { key, headers } = await setup({ autoApprove: false });
    const r = await app.inject({ method: 'POST', url: '/v1/agent/messages', headers: bearer(key), payload: { thread_ref: 't1', message: 'hi' } });
    expect(r.json().status).toBe('drafted');

    const threads = (await app.inject({ method: 'GET', url: '/api/agent/threads', headers })).json().threads;
    const detail = (await app.inject({ method: 'GET', url: `/api/agent/threads/${threads[0].id}`, headers })).json();
    const agentMsg = detail.messages.find((m: { role: string }) => m.role === 'agent');
    expect(agentMsg.status).toBe('pending_approval');

    const ok = await app.inject({ method: 'POST', url: `/api/agent/messages/${agentMsg.id}/approve`, headers });
    expect(ok.statusCode).toBe(200);
    const detail2 = (await app.inject({ method: 'GET', url: `/api/agent/threads/${threads[0].id}`, headers })).json();
    expect(detail2.messages.find((m: { role: string }) => m.role === 'agent').status).toBe('approved');
  });
});
