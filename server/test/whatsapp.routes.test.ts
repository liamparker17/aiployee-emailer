import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '@aiployee/core';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant, createUser } from './helpers/factories.js';
import { csrfFor, login } from './helpers/auth.js';

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
afterEach(() => vi.unstubAllGlobals());

async function adminSession() {
  const t = await createTenant(pool);
  const password = 'pw-12345678';
  await createUser(pool, { tenantId: t.id, email: 'admin@x.io', password, role: 'tenant_admin' });
  const csrf = await csrfFor(app);
  const headers = await login(app, { email: 'admin@x.io', password }, csrf);
  return { tenantId: t.id, headers };
}
async function nonAdminSession(tenantId: string) {
  const password = 'pw-99999999';
  await createUser(pool, { tenantId, email: 'user@x.io', password, role: 'tenant_user' });
  const csrf = await csrfFor(app);
  const headers = await login(app, { email: 'user@x.io', password }, csrf);
  return { headers };
}

const CONN = { base_url: 'https://wa.example.com/', api_key: 'aip_live_0123456789abcdef', from_number: '+27870000000' };

describe('whatsapp connection routes', () => {
  it('creates a connection, never returns the api key, strips the trailing slash', async () => {
    const { headers } = await adminSession();
    const res = await app.inject({ method: 'PUT', url: '/api/whatsapp/connection', headers, payload: CONN });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('aip_live_0123456789abcdef');
    const { connection } = JSON.parse(res.body);
    expect(connection.hasKey).toBe(true);
    expect(connection.base_url).toBe('https://wa.example.com');
  });

  it('400 creating without an api key, but updates keep the saved key', async () => {
    const { headers } = await adminSession();
    const noKey = await app.inject({ method: 'PUT', url: '/api/whatsapp/connection', headers,
      payload: { base_url: CONN.base_url } });
    expect(noKey.statusCode).toBe(400);

    await app.inject({ method: 'PUT', url: '/api/whatsapp/connection', headers, payload: CONN });
    const update = await app.inject({ method: 'PUT', url: '/api/whatsapp/connection', headers,
      payload: { base_url: 'https://wa2.example.com', from_number: null } });
    expect(update.statusCode).toBe(200);
    const { connection } = JSON.parse(update.body);
    expect(connection.base_url).toBe('https://wa2.example.com');
    expect(connection.from_number).toBeNull();

    // the kept key still decrypts: a stubbed send authenticates with it
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'm_1' }), { status: 200 });
    }));
    const test = await app.inject({ method: 'POST', url: '/api/whatsapp/test', headers, payload: { to: '+27821234567' } });
    expect(test.statusCode).toBe(200);
    expect(JSON.parse(test.body).ok).toBe(true);
    const headersSent = calls[0].init.headers as Record<string, string>;
    expect(headersSent.Authorization).toBe(`Bearer ${CONN.api_key}`);
  });

  it('400 on an http base_url', async () => {
    const { headers } = await adminSession();
    const res = await app.inject({ method: 'PUT', url: '/api/whatsapp/connection', headers,
      payload: { ...CONN, base_url: 'http://wa.example.com' } });
    expect(res.statusCode).toBe(400);
  });

  it('test send posts the v1 message contract with an idempotency key', async () => {
    const { headers } = await adminSession();
    await app.inject({ method: 'PUT', url: '/api/whatsapp/connection', headers, payload: CONN });
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'm_1' }), { status: 200 });
    }));
    const res = await app.inject({ method: 'POST', url: '/api/whatsapp/test', headers,
      payload: { to: '+27821234567', message: 'hello' } });
    expect(res.statusCode).toBe(200);
    expect(calls[0].url).toBe('https://wa.example.com/api/v1/messages');
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent).toMatchObject({ channel: 'whatsapp', to: '+27821234567', message: 'hello', from: CONN.from_number });
    const h = calls[0].init.headers as Record<string, string>;
    expect(h['Idempotency-Key']).toBeTruthy();
  });

  it('test send records the failure on the connection', async () => {
    const { headers } = await adminSession();
    await app.inject({ method: 'PUT', url: '/api/whatsapp/connection', headers, payload: CONN });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"missing_scope"}', { status: 403 })));
    const res = await app.inject({ method: 'POST', url: '/api/whatsapp/test', headers, payload: { to: '+27821234567' } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(false);
    const get = await app.inject({ method: 'GET', url: '/api/whatsapp/connection', headers });
    expect(JSON.parse(get.body).connection.last_error).toBe('HTTP 403');
  });

  it('400 on a non-E.164 test number and 404 with no connection', async () => {
    const { headers } = await adminSession();
    const bad = await app.inject({ method: 'POST', url: '/api/whatsapp/test', headers, payload: { to: '0821234567' } });
    expect(bad.statusCode).toBe(400);
    const none = await app.inject({ method: 'POST', url: '/api/whatsapp/test', headers, payload: { to: '+27821234567' } });
    expect(none.statusCode).toBe(404);
  });

  it('403 for a non-admin', async () => {
    const { tenantId } = await adminSession();
    const { headers } = await nonAdminSession(tenantId);
    const res = await app.inject({ method: 'GET', url: '/api/whatsapp/connection', headers });
    expect(res.statusCode).toBe(403);
  });

  it('delete removes the connection; second delete 404s', async () => {
    const { headers } = await adminSession();
    await app.inject({ method: 'PUT', url: '/api/whatsapp/connection', headers, payload: CONN });
    const del = await app.inject({ method: 'DELETE', url: '/api/whatsapp/connection', headers });
    expect(del.statusCode).toBe(200);
    const again = await app.inject({ method: 'DELETE', url: '/api/whatsapp/connection', headers });
    expect(again.statusCode).toBe(404);
  });
});
