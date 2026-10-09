import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import smtpTester from 'smtp-tester';
import { buildApp } from '../src/app.js';
import {
  loadConfig, createSmtpConfig, createSender, insertApiKey, generateApiKey, hashApiKey, prefixOf,
  getSmtpConfigWithPassword, getSenderByEmail, createGraphSender, resolveSmtpCreds, GRAPH_SEND_SCOPE,
} from '@aiployee/core';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant, createUser } from './helpers/factories.js';
import { csrfFor, login } from './helpers/auth.js';

const KEY = Buffer.alloc(32, 1);
const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32), EMAILER_ENC_KEY: KEY.toString('base64'),
  PUBLIC_BASE_URL: 'https://emailer.test', CRON_SECRET: 'c'.repeat(24),
});

const MAILBOX = 'overflow@first4u.co.za';
const REFRESH = 'RT-overflow-secret';
const ACCESS = 'AT-overflow-secret';
const PORT = 2531;

// ── one stub for Microsoft login, Graph /me and Graph sendMail ──────────────────────────
let clock = new Date('2026-10-09T10:00:00Z');
let me: { mail: string; userPrincipalName: string };
let tokenQueue: Array<Record<string, unknown>>;
let calls: Array<{ url: string; init?: { body?: string; headers?: Record<string, string> } }>;
const stub = vi.fn(async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
  calls.push({ url: String(url), init });
  const r = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body),
    headers: { get: (k: string) => headers[k] ?? null },
  });
  const u = String(url);
  if (u.endsWith('/devicecode')) return r(200, { device_code: 'DC-secret', user_code: 'ABCD1234', verification_uri: 'https://microsoft.com/devicelogin', interval: 5, expires_in: 900 });
  if (u.endsWith('/token')) {
    const body = String(init?.body ?? '');
    if (body.includes('grant_type=refresh_token')) return r(200, { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 });
    const next = tokenQueue.shift() ?? { error: 'authorization_pending' };
    return r('access_token' in next ? 200 : 400, next);
  }
  if (u.startsWith('https://graph.microsoft.com/v1.0/me')) return r(200, me);
  if (u.includes('/sendMail')) return r(202, {}, { 'request-id': 'req-1' });
  throw new Error('unexpected fetch ' + u);
});

let app: Awaited<ReturnType<typeof buildApp>>;
let smtp: ReturnType<typeof smtpTester.init>;
const mails: Array<{ to: string; text: string }> = [];
const pool = makePool();

beforeAll(async () => {
  vi.stubGlobal('fetch', stub);
  smtp = smtpTester.init(PORT);
  smtp.bind((_addr: string, _id: number, email: { body?: string; html?: string; headers?: unknown; receivers?: Record<string, unknown> }) => {
    mails.push({ to: Object.keys(email.receivers ?? {}).join(','), text: `${email.body ?? ''}\n${email.html ?? ''}\n${JSON.stringify(email.headers ?? {})}` });
  });
  app = await buildApp({ cfg, connect: { fetchImpl: stub as never, now: () => clock } });
});
beforeEach(async () => {
  await truncateAll(pool);
  mails.length = 0; calls = []; tokenQueue = []; clock = new Date('2026-10-09T10:00:00Z');
  me = { mail: MAILBOX, userPrincipalName: MAILBOX };
});
afterAll(async () => { await app.close(); await new Promise<void>(res => smtp.stop(res)); await pool.end(); vi.unstubAllGlobals(); });

async function world() {
  // platform sender (liam@) lives in a different tenant, like production
  const platform = await createTenant(pool, 'Platform');
  const sc = await createSmtpConfig(pool, KEY, { tenantId: platform.id, name: 'plat', host: '127.0.0.1', port: PORT, secure: false, username: 'u', password: 'p', fromDomain: 'aiployee.co.za', isDefault: true });
  await createSender(pool, { tenantId: platform.id, email: 'liam@aiployee.co.za', displayName: 'Aiployee', smtpConfigId: sc.id, isDefault: true });
  const fa = await createTenant(pool, 'First Assist');
  const admin = await createUser(pool, { tenantId: fa.id, email: 'admin@first4u.co.za', password: 'pw-admin-123', role: 'tenant_admin' });
  const csrf = await csrfFor(app);
  const headers = await login(app, { email: admin.email, password: 'pw-admin-123' }, csrf);
  const faKey = generateApiKey();
  await insertApiKey(pool, { tenantId: fa.id, name: 'voice', keyHash: hashApiKey(faKey), keyPrefix: prefixOf(faKey) });
  // Invites can only be created by a platform super_admin (tenant chosen in the body).
  await createUser(pool, { tenantId: null, email: 'root@aiployee.co.za', password: 'pw-root-12345', role: 'super_admin' });
  const sa = await login(app, { email: 'root@aiployee.co.za', password: 'pw-root-12345' }, await csrfFor(app));
  const invite = (payload: Record<string, unknown>) => app.inject({
    method: 'POST', url: '/api/m365/connect-invites', headers: sa, payload: { tenantId: fa.id, ...payload },
  });
  return { platform, fa, admin, headers, sa, faKey, invite };
}
const tokenFrom = (url: string) => url.split('/connect/')[1];
const waitMail = async (pred: (m: { to: string; text: string }) => boolean) => {
  for (let i = 0; i < 40; i++) { const m = mails.find(pred); if (m) return m; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('mail not received; got: ' + JSON.stringify(mails.map(m => [m.to, m.text.slice(0, 80)])));
};
const pub = (kind: 'start' | 'status', token: string) =>
  app.inject({ method: 'POST', url: `/api/public/m365-connect/${kind}`, payload: { token } }); // no cookie, no CSRF header

describe('emailed connect: end to end', () => {
  it('invite -> email -> device code -> connected -> FA key sends from the connected mailbox via Graph', async () => {
    const w = await world();
    const create = await w.invite({ mailbox: MAILBOX, recipientEmail: MAILBOX, displayName: 'First Assist Overflow', allowShared: true });
    expect(create.statusCode).toBe(201);
    const { connectUrl, emailSent, invite } = create.json() as { connectUrl: string; emailSent: boolean; invite: { id: string; tenantId: string } };
    expect(emailSent).toBe(true);
    expect(invite.tenantId).toBe(w.fa.id);
    expect(connectUrl.startsWith('https://emailer.test/connect/')).toBe(true);
    const token = tokenFrom(connectUrl);

    // invite email: sent from the platform sender, to the recipient, with the link
    const inviteMail = await waitMail(m => m.to === MAILBOX && m.text.includes('Connect your mailbox'));
    expect(inviteMail.text).toContain(connectUrl);
    // token hashed at rest
    const row = await pool.query('SELECT token_hash, status, expires_at FROM m365_connect_invites');
    expect(row.rows[0].token_hash).not.toContain(token);
    expect(new Date(row.rows[0].expires_at).getTime() - clock.getTime()).toBe(72 * 3600 * 1000);

    // public page: start (no session, no CSRF) shows the code, never the device code
    const start = await pub('start', token);
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ state: 'waiting', mailbox: MAILBOX, userCode: 'ABCD1234' });
    expect(start.body).not.toContain('DC-secret');
    expect(start.headers['cache-control']).toBe('no-store');
    // pending, then success once Microsoft says so
    clock = new Date(clock.getTime() + 6000);
    expect((await pub('status', token)).json()).toMatchObject({ state: 'waiting' });
    clock = new Date(clock.getTime() + 6000);
    tokenQueue.push({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 });
    const done = await pub('status', token);
    expect(done.json()).toEqual({ state: 'connected', mailbox: MAILBOX });
    expect(done.body).not.toContain(REFRESH);

    // sender + graph smtp_config created like /graph-send/complete
    const sender = await getSenderByEmail(pool, w.fa.id, MAILBOX);
    expect(sender).not.toBeNull();
    expect(sender!.display_name).toBe('First Assist Overflow');
    const sc = await getSmtpConfigWithPassword(pool, KEY, w.fa.id, sender!.smtp_config_id);
    expect(sc!.auth_type).toBe('graph');
    expect(sc!.refreshToken).toBe(REFRESH);
    expect(sc!.oauth_client_id).toBe('14d82eec-204b-4c2f-b7e8-296a70dab67e');
    expect(sc!.oauth_tenant).toBe('common');
    expect(sc!.password).toBeNull();

    // link is single-use; the invite is marked used
    expect((await pub('start', token)).json()).toEqual({ state: 'used' });
    const after = await pool.query('SELECT status, used_at, sender_id FROM m365_connect_invites');
    expect(after.rows[0].status).toBe('connected');
    expect(after.rows[0].sender_id).toBe(sender!.id);

    // admin is notified
    await waitMail(m => m.to === 'root@aiployee.co.za' && m.text.includes('is now connected'));

    // The First Assist key (same Emailer tenant) can send with from = connected mailbox,
    // passes the invalid_sender check and goes out through the Graph path.
    calls = [];
    const send = await app.inject({ method: 'POST', url: '/v1/emails', headers: { authorization: `Bearer ${w.faKey}` },
      payload: { from: MAILBOX, to: 'preshalin@first4u.co.za', subject: 'Call summary', html: '<p>hi</p>' } });
    expect(send.statusCode).toBe(202);
    expect((send.json() as { status: string }).status).toBe('sent');
    const refresh = calls.find(c => c.url.endsWith('/token'))!;
    expect(refresh.init!.body).toContain('grant_type=refresh_token');
    // shared invite => this config alone refreshes with its own stored scope
    expect(decodeURIComponent(refresh.init!.body!)).toContain('scope=https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Send.Shared offline_access');
    const graph = calls.find(c => c.url.includes('/sendMail'))!;
    expect(graph.url).toBe(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/sendMail`);
    expect(graph.init!.headers!.Authorization).toBe(`Bearer ${ACCESS}`);
    const sent = JSON.parse(graph.init!.body!) as { message: { from: { emailAddress: { address: string } }; toRecipients: Array<{ emailAddress: { address: string } }> } };
    expect(sent.message.from.emailAddress.address).toBe(MAILBOX);
    expect(sent.message.toRecipients[0].emailAddress.address).toBe('preshalin@first4u.co.za');
    // and an unconnected address is still rejected
    const bad = await app.inject({ method: 'POST', url: '/v1/emails', headers: { authorization: `Bearer ${w.faKey}` },
      payload: { from: 'nobody@first4u.co.za', to: 'x@y.com', subject: 's', html: '<p>x</p>' } });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { error: { code: string } }).error.code).toBe('invalid_sender');
  });

  it('mismatch via the route stores no sender and emails the admin', async () => {
    const w = await world();
    const c = await w.invite({ mailbox: MAILBOX, recipientEmail: MAILBOX });
    const token = tokenFrom((c.json() as { connectUrl: string }).connectUrl);
    me = { mail: 'stranger@first4u.co.za', userPrincipalName: 'stranger@first4u.co.za' };
    await pub('start', token);
    clock = new Date(clock.getTime() + 6000);
    tokenQueue.push({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 });
    expect((await pub('status', token)).json()).toMatchObject({ state: 'mismatch' });
    expect(await getSenderByEmail(pool, w.fa.id, MAILBOX)).toBeNull();
    expect((await pool.query('SELECT count(*)::int AS n FROM smtp_configs WHERE tenant_id=$1', [w.fa.id])).rows[0].n).toBe(0);
    await waitMail(m => m.to === 'root@aiployee.co.za' && m.text.includes('Connection problem'));
  });
});

describe('emailed connect: authorisation and abuse limits', () => {
  it('only super_admin can create invites (tenant admins and users cannot, even for their own tenant)', async () => {
    const w = await world();
    const other = await createTenant(pool, 'Other');
    const r1 = await app.inject({ method: 'POST', url: '/api/m365/connect-invites', headers: w.headers, payload: { mailbox: MAILBOX, recipientEmail: MAILBOX, tenantId: other.id } });
    expect(r1.statusCode).toBe(403);
    const r1b = await app.inject({ method: 'POST', url: '/api/m365/connect-invites', headers: w.headers, payload: { mailbox: MAILBOX, recipientEmail: MAILBOX } });
    expect(r1b.statusCode).toBe(403);
    const r2 = await w.invite({ mailbox: MAILBOX, recipientEmail: MAILBOX });
    expect(r2.statusCode).toBe(201);
    expect((r2.json() as { invite: { tenantId: string } }).invite.tenantId).toBe(w.fa.id);
    await createUser(pool, { tenantId: w.fa.id, email: 'u@first4u.co.za', password: 'pw-user-12345', role: 'tenant_user' });
    const uh = await login(app, { email: 'u@first4u.co.za', password: 'pw-user-12345' }, await csrfFor(app));
    const r3 = await app.inject({ method: 'POST', url: '/api/m365/connect-invites', headers: uh, payload: { mailbox: MAILBOX, recipientEmail: MAILBOX } });
    expect(r3.statusCode).toBe(403);
    const anon = await app.inject({ method: 'POST', url: '/api/m365/connect-invites', payload: { mailbox: MAILBOX, recipientEmail: MAILBOX } });
    expect([401, 403]).toContain(anon.statusCode);
  });

  it('invalid tokens answer identically (no mailbox leak) and public start is rate limited per token', async () => {
    await world();
    const a = await pub('start', 'A'.repeat(43));
    const b = await pub('start', 'not-a-token');
    expect(a.json()).toEqual({ state: 'invalid' });
    expect(b.json()).toEqual({ state: 'invalid' });
    let last = 200;
    for (let i = 0; i < 12; i++) last = (await pub('start', 'B'.repeat(43))).statusCode;
    expect(last).toBe(429);
  });

  it('revoked invites stop working', async () => {
    const w = await world();
    const c = await w.invite({ mailbox: MAILBOX, recipientEmail: MAILBOX });
    const { invite, connectUrl } = c.json() as { invite: { id: string }; connectUrl: string };
    const rv = await app.inject({ method: 'POST', url: `/api/m365/connect-invites/${invite.id}/revoke`, headers: w.headers });
    expect(rv.statusCode).toBe(200);
    expect((await pub('start', tokenFrom(connectUrl))).json()).toEqual({ state: 'invalid' });
    const list = await app.inject({ method: 'GET', url: '/api/m365/connect-invites', headers: w.headers });
    expect(JSON.stringify(list.json())).not.toContain(tokenFrom(connectUrl));
    expect(JSON.stringify(list.json())).not.toContain('token_hash');
  });

  it('caps invites per tenant per 24h', async () => {
    const w = await world();
    for (let i = 0; i < 10; i++) expect((await w.invite({ mailbox: `m${i}@first4u.co.za`, recipientEmail: 'x@first4u.co.za' })).statusCode).toBe(201);
    const over = await w.invite({ mailbox: 'm11@first4u.co.za', recipientEmail: 'x@first4u.co.za' });
    expect(over.statusCode).toBe(429);
    expect((over.json() as { error: { code: string } }).error.code).toBe('invite_limit');
    const other = await createTenant(pool, 'Other2'); // cap is per tenant
    const ok = await app.inject({ method: 'POST', url: '/api/m365/connect-invites', headers: w.sa, payload: { mailbox: 'a@o.co.za', recipientEmail: 'a@o.co.za', tenantId: other.id } });
    expect(ok.statusCode).toBe(201);
  });
});

describe('existing senders are unaffected', () => {
  it('a mismatch never overwrites an existing sender for that mailbox', async () => {
    const w = await world();
    const old = await createGraphSender(pool, KEY, { tenantId: w.fa.id, username: MAILBOX, name: 'Old', fromDomain: 'first4u.co.za',
      clientId: '14d82eec-204b-4c2f-b7e8-296a70dab67e', oauthTenant: 'common', refreshToken: 'RT-ORIGINAL' });
    const c = await w.invite({ mailbox: MAILBOX, recipientEmail: MAILBOX });
    const token = tokenFrom((c.json() as { connectUrl: string }).connectUrl);
    me = { mail: MAILBOX, userPrincipalName: 'attacker@evil.onmicrosoft.com' }; // nOAuth probe
    await pub('start', token);
    clock = new Date(clock.getTime() + 6000);
    tokenQueue.push({ access_token: ACCESS, refresh_token: 'RT-ATTACKER', expires_in: 3600 });
    expect((await pub('status', token)).json()).toMatchObject({ state: 'mismatch' });
    const cfgRow = await getSmtpConfigWithPassword(pool, KEY, w.fa.id, old.smtpConfig.id);
    expect(cfgRow!.refreshToken).toBe('RT-ORIGINAL');
  });

  it('refresh requests for existing (non-shared) Graph senders are byte-identical to master', async () => {
    const w = await world();
    const g = await createGraphSender(pool, KEY, { tenantId: w.fa.id, username: 'old@first4u.co.za', name: 'Old', fromDomain: 'first4u.co.za',
      clientId: '14d82eec-204b-4c2f-b7e8-296a70dab67e', oauthTenant: 'common', refreshToken: 'RT-old' });
    const cfgRow = (await getSmtpConfigWithPassword(pool, KEY, w.fa.id, g.smtpConfig.id))!;
    expect(cfgRow.oauth_scope ?? null).toBeNull();
    calls = [];
    await resolveSmtpCreds(pool, KEY, cfgRow);
    const tok = calls.find(c => c.url.endsWith('/token'))!;
    expect(tok.url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    // exactly what master's refreshAccessToken posts (key order and encoding included)
    expect(tok.init!.body).toBe(
      `grant_type=refresh_token&client_id=14d82eec-204b-4c2f-b7e8-296a70dab67e&refresh_token=RT-old&scope=${encodeURIComponent(GRAPH_SEND_SCOPE)}`);
  });

  it('a non-shared connect leaves oauth_scope NULL', async () => {
    const w = await world();
    const c = await w.invite({ mailbox: MAILBOX, recipientEmail: MAILBOX });
    const token = tokenFrom((c.json() as { connectUrl: string }).connectUrl);
    await pub('start', token);
    clock = new Date(clock.getTime() + 6000);
    tokenQueue.push({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 });
    expect((await pub('status', token)).json()).toMatchObject({ state: 'connected' });
    const r = await pool.query('SELECT oauth_scope FROM smtp_configs WHERE username=$1', [MAILBOX]);
    expect(r.rows[0].oauth_scope).toBeNull();
  });
});
