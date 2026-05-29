import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant, createUser } from './helpers/factories.js';
import { csrfFor, login } from './helpers/auth.js';
import { insertApiKey } from '../src/repos/apiKeys.js';
import { generateApiKey, hashApiKey, prefixOf } from '../src/auth/apiKey.js';
import { signBody } from '../src/agent/webhook.js';

const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
  CRON_SECRET: 'c'.repeat(24),
});

// Configurable stub LLM (no real OpenAI). When `toolMode` is on and tools are
// offered, the first chat returns a tool call, the next returns text.
let toolMode = false;
const stubFactory = () => {
  let calls = 0;
  return {
    chat: async ({ tools }: { tools?: Array<{ name: string }> }) => {
      calls++;
      if (toolMode && tools && tools.length && calls === 1) {
        return { content: null, toolCalls: [{ id: 'tc1', name: tools[0].name, arguments: '{}' }] };
      }
      return { content: 'STUB REPLY', toolCalls: [] };
    },
  };
};

// Stub MCP provider — exposes `mcpTools` and records calls. No real MCP connection.
let mcpTools: Array<{ name: string; description: string; parameters: Record<string, unknown> }> = [];
const mcpCalls: string[] = [];
const stubMcpFactory = () => ({
  async listTools() { return mcpTools; },
  async callTool(name: string) { mcpCalls.push(name); return 'TOOL RESULT'; },
  async close() { /* noop */ },
});

// Capture webhook deliveries instead of making real HTTP calls.
let captured: Array<{ url: string; signature: string; raw: string; body: Record<string, unknown> }> = [];
const captureSender = {
  async send({ url, signature, body }: { url: string; signature: string; body: string }) {
    captured.push({ url, signature, raw: body, body: JSON.parse(body) });
    return { ok: true, status: 200 };
  },
};

let app: Awaited<ReturnType<typeof buildApp>>;
const pool = makePool();
beforeAll(async () => { app = await buildApp({ cfg, agentLlmFactory: stubFactory, agentWebhookSender: captureSender, agentMcpProviderFactory: stubMcpFactory }); });
beforeEach(async () => { await truncateAll(pool); captured = []; toolMode = false; mcpTools = []; mcpCalls.length = 0; });
afterAll(async () => { await app.close(); await pool.end(); });

async function loginAs(email: string, password: string) {
  const csrf = await csrfFor(app);
  return login(app, { email, password }, csrf);
}

/** Set up a tenant with an admin (session) and an API key (Jobix ingest). */
const WEBHOOK_URL = 'https://jobix.example/hook';
const WEBHOOK_SECRET = 'whsec_test';

async function setup(opts: { autoApprove?: boolean; enabled?: boolean; webhook?: boolean } = {}) {
  const t = await createTenant(pool);
  await createUser(pool, { tenantId: t.id, email: 'admin@x.com', password: 'pw12345678', role: 'tenant_admin' });
  const headers = await loginAs('admin@x.com', 'pw12345678');
  const key = generateApiKey();
  await insertApiKey(pool, { tenantId: t.id, name: 'k', keyHash: hashApiKey(key), keyPrefix: prefixOf(key) });
  if (opts.enabled !== false) {
    const payload: Record<string, unknown> = { enabled: true, model: 'gpt-4o', systemPrompt: '', autoApproveJobix: opts.autoApprove ?? true, maxToolIterations: 4, openaiKey: 'sk-test' };
    if (opts.webhook) { payload.jobixWebhookUrl = WEBHOOK_URL; payload.jobixWebhookSecret = WEBHOOK_SECRET; }
    await app.inject({ method: 'PUT', url: '/api/agent/config', headers, payload });
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

describe('MCP tools (Phase 3)', () => {
  it('runs a tool-calling loop and invokes the MCP tool', async () => {
    const { key } = await setup({ autoApprove: true });
    toolMode = true;
    mcpTools = [{ name: 'srv__lookup', description: 'Look something up', parameters: { type: 'object', properties: {} } }];
    const r = await app.inject({ method: 'POST', url: '/v1/agent/messages', headers: bearer(key), payload: { thread_ref: 't1', message: 'use the tool' } });
    expect(r.statusCode).toBe(202);
    expect(r.json().response_text).toBe('STUB REPLY');     // final turn after the tool result
    expect(mcpCalls).toContain('srv__lookup');             // the tool was actually called
  });

  it('CRUD: create, list, delete an MCP server (admin only)', async () => {
    const { headers } = await setup();
    const create = await app.inject({ method: 'POST', url: '/api/agent/mcp-servers', headers, payload: { name: 'My MCP', url: 'https://mcp.example/sse', authHeader: 'Bearer xyz' } });
    expect(create.statusCode).toBe(201);
    expect(create.json().server.has_auth).toBe(true);
    expect(create.json().server).not.toHaveProperty('auth_header_encrypted');
    const id = create.json().server.id;

    const list = await app.inject({ method: 'GET', url: '/api/agent/mcp-servers', headers });
    expect(list.json().servers).toHaveLength(1);

    const del = await app.inject({ method: 'DELETE', url: `/api/agent/mcp-servers/${id}`, headers });
    expect(del.statusCode).toBe(200);
    const list2 = await app.inject({ method: 'GET', url: '/api/agent/mcp-servers', headers });
    expect(list2.json().servers).toHaveLength(0);
  });
});

describe('Jobix outbound webhook', () => {
  it('delivers a signed agent.response when configured (auto-approved)', async () => {
    const { key } = await setup({ autoApprove: true, webhook: true });
    await app.inject({ method: 'POST', url: '/v1/agent/messages', headers: bearer(key), payload: { thread_ref: 't1', message: 'hi' } });
    expect(captured).toHaveLength(1);
    const c = captured[0];
    expect(c.url).toBe(WEBHOOK_URL);
    expect(c.body.event).toBe('agent.response');
    expect(c.body.status).toBe('sent');
    expect(c.body.thread_ref).toBe('t1');
    expect(c.body.response_text).toBe('STUB REPLY');
    // signature is HMAC-SHA256 of the exact body with the tenant's secret
    expect(c.signature).toBe(signBody(c.raw, WEBHOOK_SECRET));
  });

  it('does not call the webhook when none is configured', async () => {
    const { key } = await setup({ autoApprove: true, webhook: false });
    const r = await app.inject({ method: 'POST', url: '/v1/agent/messages', headers: bearer(key), payload: { thread_ref: 't1', message: 'hi' } });
    expect(r.statusCode).toBe(202);
    expect(captured).toHaveLength(0);
  });

  it('fires status "rejected" when a draft is rejected', async () => {
    const { key, headers } = await setup({ autoApprove: false, webhook: true });
    await app.inject({ method: 'POST', url: '/v1/agent/messages', headers: bearer(key), payload: { thread_ref: 't1', message: 'hi' } });
    // first delivery: drafted
    expect(captured.map(c => c.body.status)).toContain('drafted');
    const threads = (await app.inject({ method: 'GET', url: '/api/agent/threads', headers })).json().threads;
    const detail = (await app.inject({ method: 'GET', url: `/api/agent/threads/${threads[0].id}`, headers })).json();
    const agentMsg = detail.messages.find((m: { role: string }) => m.role === 'agent');
    await app.inject({ method: 'POST', url: `/api/agent/messages/${agentMsg.id}/reject`, headers });
    expect(captured.map(c => c.body.status)).toContain('rejected');
  });
});
