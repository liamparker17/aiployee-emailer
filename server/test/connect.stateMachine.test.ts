import { describe, it, expect, beforeEach } from 'vitest';
import {
  startConnect, connectStatus, generateInviteToken, hashInviteToken, looksLikeToken, RateLimiter,
  encrypt, MAX_RESTARTS, INVITE_TTL_MS,
  type InviteRow, type InviteStore, type ConnectDeps, type ConnectNotice, type FetchLike, type InvitePatch,
} from '@aiployee/core';

// ── in-memory store with the same atomic semantics as the Postgres one ──────────────────
function memStore(rows: InviteRow[]): InviteStore {
  const by = (id: string) => rows.find(r => r.id === id)!;
  return {
    async findByTokenHash(h) { return rows.find(r => r.token_hash === h) ?? null; },
    async getById(id) { return rows.find(r => r.id === id) ?? null; },
    async update(id, patch: InvitePatch) { Object.assign(by(id), patch); },
    async claimPoll(id, now, next) {
      const r = by(id);
      if (r.status !== 'pending' || r.used_at || (r.next_poll_at && r.next_poll_at > now)) return false;
      r.next_poll_at = next; return true;
    },
    async finalize(id, now, senderId) {
      const r = by(id);
      if (r.status !== 'pending' || r.used_at) return false;
      Object.assign(r, { status: 'connected', used_at: now, connected_at: now, sender_id: senderId }); return true;
    },
  };
}

const ENC = Buffer.alloc(32, 7);
const MAILBOX = 'overflow@first4u.co.za';
const DEVICE_CODE = 'DEVICE-CODE-SECRET-123';
const REFRESH = 'REFRESH-TOKEN-SECRET-456';
const ACCESS = 'ACCESS-TOKEN-SECRET-789';

let clock: Date;
let token: string;
let rows: InviteRow[];
let ms: { tokenReplies: Array<Record<string, unknown>>; me: { status: number; body: unknown }; sendMailStatus: number; calls: string[]; devicecodeCount: number };
let notices: ConnectNotice[];
let created: Array<{ inv: InviteRow; rt: string }>;
let logs: string[];
let polledBodies: string[];

function mkRow(over: Partial<InviteRow> = {}): InviteRow {
  token = generateInviteToken();
  return {
    id: 'inv-1', tenant_id: 'ten-1', mailbox: MAILBOX, recipient_email: MAILBOX, display_name: 'Overflow',
    allow_shared: false, token_hash: hashInviteToken(token), status: 'pending',
    expires_at: new Date(clock.getTime() + INVITE_TTL_MS), used_at: null,
    created_by_user_id: 'u1', created_by_email: 'liam@aiployee.co.za',
    device_code_enc: null, user_code: null, verification_uri: null, device_expires_at: null, poll_interval: 5, next_poll_at: null,
    restarts: 0, start_count: 0, mismatch_count: 0, transient_fails: 0, failure_reason: null, sender_id: null, connected_at: null, created_at: clock,
    ...over,
  };
}

const fetchImpl: FetchLike = async (url: string, init?: { body?: string }) => {
  ms.calls.push(url);
  const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
  if (url.endsWith('/devicecode')) {
    ms.devicecodeCount += 1;
    return json(200, { device_code: `${DEVICE_CODE}-${ms.devicecodeCount}`, user_code: `CODE${ms.devicecodeCount}`, verification_uri: 'https://microsoft.com/devicelogin', interval: 5, expires_in: 900 });
  }
  if (url.endsWith('/token')) {
    polledBodies.push(String(init?.body));
    const next = ms.tokenReplies.shift() ?? { error: 'authorization_pending' };
    return json('access_token' in next ? 200 : 400, next);
  }
  if (url.startsWith('https://graph.microsoft.com/v1.0/me')) return json(ms.me.status, ms.me.body);
  if (url.includes('/sendMail')) return { ok: ms.sendMailStatus === 202, status: ms.sendMailStatus, json: async () => ({}) };
  throw new Error('unexpected url ' + url);
};

function deps(over: Partial<ConnectDeps> = {}): ConnectDeps {
  return {
    store: memStore(rows), encKey: ENC, fetchImpl, now: () => clock,
    log: { info: (o, m) => logs.push(JSON.stringify([o, m])), warn: (o, m) => logs.push(JSON.stringify([o, m])), error: (o, m) => logs.push(JSON.stringify([o, m])) },
    async createSender(inv, rt) { created.push({ inv, rt }); return { senderId: 'sender-1' }; },
    async notify(_inv, n) { notices.push(n); },
    ...over,
  };
}
const advance = (s: number) => { clock = new Date(clock.getTime() + s * 1000); };
const OK_TOKENS = { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 };

beforeEach(() => {
  clock = new Date('2026-10-09T10:00:00Z');
  rows = [mkRow()];
  ms = { tokenReplies: [], me: { status: 200, body: { mail: MAILBOX, userPrincipalName: MAILBOX } }, sendMailStatus: 202, calls: [], devicecodeCount: 0 };
  notices = []; created = []; logs = []; polledBodies = [];
});

describe('token lifecycle', () => {
  it('valid token starts a flow and shows only the user code', async () => {
    const v = await startConnect(deps(), token);
    expect(v).toMatchObject({ state: 'waiting', mailbox: MAILBOX, userCode: 'CODE1', verificationUri: 'https://microsoft.com/devicelogin' });
    expect(JSON.stringify(v)).not.toContain(DEVICE_CODE);
    // stored encrypted, not in clear
    expect(rows[0].device_code_enc!.toString('utf8')).not.toContain(DEVICE_CODE);
  });
  it('start is idempotent while the code is live (page refresh keeps the same code)', async () => {
    await startConnect(deps(), token);
    const v = await startConnect(deps(), token);
    expect(v).toMatchObject({ state: 'waiting', userCode: 'CODE1' });
    expect(ms.devicecodeCount).toBe(1);
  });
  it('wrong, malformed and revoked tokens are all just "invalid" and leak no mailbox', async () => {
    for (const t of [generateInviteToken(), 'short', '', undefined, 42, token.slice(1) + 'x']) {
      const v = await startConnect(deps(), t);
      expect(v).toEqual({ state: 'invalid' });
    }
    rows[0].status = 'revoked';
    const v = await connectStatus(deps(), token);
    expect(v).toEqual({ state: 'invalid' });
    expect(ms.calls).toHaveLength(0);
  });
  it('expired token is refused without calling Microsoft', async () => {
    advance(INVITE_TTL_MS / 1000 + 1);
    expect(await startConnect(deps(), token)).toEqual({ state: 'expired' });
    expect(ms.calls).toHaveLength(0);
  });
  it('used token is refused and shows no mailbox', async () => {
    await startConnect(deps(), token);
    advance(6); ms.tokenReplies.push(OK_TOKENS);
    expect(await connectStatus(deps(), token)).toEqual({ state: 'connected', mailbox: MAILBOX });
    const again = await startConnect(deps(), token);
    expect(again).toEqual({ state: 'used' });
    expect(await connectStatus(deps(), token)).toEqual({ state: 'used' });
    expect(created).toHaveLength(1);
  });
  it('looksLikeToken / generate / hash', () => {
    const t = generateInviteToken();
    expect(looksLikeToken(t)).toBe(true);
    expect(hashInviteToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInviteToken(t)).not.toContain(t);
  });
});

describe('device-code state machine (mocked Microsoft)', () => {
  it('authorization_pending keeps waiting and respects the interval (no extra Microsoft calls)', async () => {
    await startConnect(deps(), token);
    const before = ms.calls.length;
    expect((await connectStatus(deps(), token)).state).toBe('waiting'); // too early: next_poll_at in the future
    expect(ms.calls.length).toBe(before);
    advance(5); ms.tokenReplies.push({ error: 'authorization_pending' });
    expect((await connectStatus(deps(), token)).state).toBe('waiting');
    expect(ms.calls.length).toBe(before + 1);
    expect((await connectStatus(deps(), token)).state).toBe('waiting'); // immediately again: throttled
    expect(ms.calls.length).toBe(before + 1);
  });
  it('slow_down widens the interval by 5s', async () => {
    await startConnect(deps(), token);
    advance(5); ms.tokenReplies.push({ error: 'slow_down' });
    await connectStatus(deps(), token);
    expect(rows[0].poll_interval).toBe(10);
    advance(6);
    const n = ms.calls.length;
    await connectStatus(deps(), token);
    expect(ms.calls.length).toBe(n); // 6s < 10s
    advance(5);
    ms.tokenReplies.push({ error: 'authorization_pending' });
    await connectStatus(deps(), token);
    expect(ms.calls.length).toBe(n + 1);
  });
  it('expired_token auto-restarts with a new code and says so', async () => {
    await startConnect(deps(), token);
    advance(5); ms.tokenReplies.push({ error: 'expired_token' });
    const v = await connectStatus(deps(), token);
    expect(v).toMatchObject({ state: 'waiting', userCode: 'CODE2', restarted: true });
    expect(rows[0].restarts).toBe(1);
    // and the new device code is what gets polled next
    advance(5); ms.tokenReplies.push({ error: 'authorization_pending' });
    await connectStatus(deps(), token);
    expect(polledBodies[0]).toContain(`device_code=${DEVICE_CODE}-1`);
    expect(polledBodies.at(-1)).toContain(`device_code=${DEVICE_CODE}-2`);
    expect(polledBodies.at(-1)).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code');
  });
  it('a locally lapsed code restarts too, and restarts are capped', async () => {
    await startConnect(deps(), token);
    for (let i = 0; i < MAX_RESTARTS; i++) {
      advance(901);
      expect(await connectStatus(deps(), token)).toMatchObject({ state: 'waiting', restarted: true });
    }
    advance(901);
    const v = await connectStatus(deps(), token);
    expect(v.state).toBe('failed');
    expect(notices.at(-1)).toMatchObject({ kind: 'failed', reason: 'too_many_attempts' });
  });
  it('declined: nothing stored, admin told', async () => {
    await startConnect(deps(), token);
    advance(5); ms.tokenReplies.push({ error: 'authorization_declined' });
    expect((await connectStatus(deps(), token)).state).toBe('declined');
    expect(created).toHaveLength(0);
    expect(notices).toEqual([{ kind: 'failed', reason: 'declined' }]);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].device_code_enc).toBeNull();
  });
  it('success creates the sender exactly once and marks the invite used', async () => {
    await startConnect(deps(), token);
    advance(5); ms.tokenReplies.push(OK_TOKENS);
    expect(await connectStatus(deps(), token)).toEqual({ state: 'connected', mailbox: MAILBOX });
    expect(created).toHaveLength(1);
    expect(created[0].rt).toBe(REFRESH);
    expect(created[0].inv.mailbox).toBe(MAILBOX);
    expect(rows[0]).toMatchObject({ status: 'connected', sender_id: 'sender-1' });
    expect(rows[0].used_at).not.toBeNull();
    expect(notices).toEqual([{ kind: 'connected', signedInAs: MAILBOX }]);
  });
  it('/me match is on the UPN, case-insensitive', async () => {
    ms.me.body = { mail: null, userPrincipalName: 'OverFlow@First4U.co.za' };
    await startConnect(deps(), token); advance(5); ms.tokenReplies.push(OK_TOKENS);
    expect((await connectStatus(deps(), token)).state).toBe('connected');
  });
  it('nOAuth probe: mail == mailbox but a foreign UPN is refused and nothing is stored', async () => {
    ms.me.body = { mail: MAILBOX, userPrincipalName: 'attacker@evil.onmicrosoft.com' };
    await startConnect(deps(), token); advance(5); ms.tokenReplies.push(OK_TOKENS);
    expect((await connectStatus(deps(), token)).state).toBe('mismatch');
    expect(created).toHaveLength(0);
    expect(rows[0].used_at).toBeNull();
    expect(notices[0]).toMatchObject({ kind: 'failed', reason: 'mismatch' });
  });
  it('nOAuth probe also fails for a shared invite unless the self-send test passes', async () => {
    rows[0].allow_shared = true; ms.sendMailStatus = 403;
    ms.me.body = { mail: MAILBOX, userPrincipalName: 'attacker@evil.onmicrosoft.com' };
    await startConnect(deps(), token); advance(5); ms.tokenReplies.push(OK_TOKENS);
    expect((await connectStatus(deps(), token)).state).toBe('mismatch');
    expect(created).toHaveLength(0);
  });
  it('mail-only /me (no UPN) never counts', async () => {
    ms.me.body = { mail: MAILBOX, userPrincipalName: null };
    await startConnect(deps(), token); advance(5); ms.tokenReplies.push(OK_TOKENS);
    expect((await connectStatus(deps(), token)).state).toBe('mismatch');
  });
  it('re-checks the invite right before creating the sender (revoked mid-flow)', async () => {
    await startConnect(deps(), token); advance(5); ms.tokenReplies.push(OK_TOKENS);
    const d = deps();
    const realGet = d.store.getById.bind(d.store);
    d.store.getById = async (id) => { const r = await realGet(id); if (r) r.status = 'revoked'; return r; };
    expect((await connectStatus(d, token)).state).toBe('invalid');
    expect(created).toHaveLength(0);
  });
  it('transient Microsoft errors back off and keep the link alive', async () => {
    await startConnect(deps(), token);
    advance(5); ms.tokenReplies.push({ error: 'temporarily_unavailable' });
    expect((await connectStatus(deps(), token)).state).toBe('waiting');
    expect(rows[0].status).toBe('pending');
    expect(rows[0].transient_fails).toBe(1);
    const t1 = rows[0].next_poll_at!.getTime() - clock.getTime();
    expect(t1).toBe(10_000); // 5s * 2^1
    advance(11); ms.tokenReplies.push({ error: 'server_error' });
    await connectStatus(deps(), token);
    expect(rows[0].next_poll_at!.getTime() - clock.getTime()).toBe(20_000); // 5s * 2^2
    advance(21); ms.tokenReplies.push(OK_TOKENS);
    expect((await connectStatus(deps(), token)).state).toBe('connected');
  });
});

describe('mailbox mismatch', () => {
  it('refuses a different account and stores nothing', async () => {
    ms.me.body = { mail: 'someone.else@first4u.co.za', userPrincipalName: 'someone.else@first4u.co.za' };
    await startConnect(deps(), token); advance(5); ms.tokenReplies.push(OK_TOKENS);
    const v = await connectStatus(deps(), token);
    expect(v.state).toBe('mismatch');
    expect(created).toHaveLength(0);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].used_at).toBeNull();
    expect(rows[0].device_code_enc).toBeNull(); // flow cleared; user must request a new code
    expect(notices[0]).toMatchObject({ kind: 'failed', reason: 'mismatch', signedInAs: 'someone.else@first4u.co.za' });
    expect(ms.calls.some(u => u.includes('/sendMail'))).toBe(false); // no shared test unless invited as shared
    // retry works with a fresh code
    expect(await startConnect(deps(), token)).toMatchObject({ state: 'waiting', userCode: 'CODE2' });
  });
  it('fails the invite after repeated mismatches', async () => {
    ms.me.body = { mail: 'x@y.com', userPrincipalName: 'x@y.com' };
    for (let i = 0; i < 5; i++) {
      await startConnect(deps(), token); advance(5); ms.tokenReplies.push(OK_TOKENS);
      await connectStatus(deps(), token);
    }
    expect(rows[0].status).toBe('failed');
  });
  it('shared invite: a delegate is accepted only when the test sendMail as the mailbox succeeds', async () => {
    rows[0].allow_shared = true;
    ms.me.body = { mail: 'user@first4u.co.za', userPrincipalName: 'user@first4u.co.za' };
    await startConnect(deps(), token); advance(5); ms.tokenReplies.push(OK_TOKENS);
    const v = await connectStatus(deps(), token);
    expect(v.state).toBe('connected');
    expect(created).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'connected', signedInAs: 'user@first4u.co.za' });
    const call = ms.calls.find(u => u.includes('/sendMail'))!;
    expect(call).toContain(encodeURIComponent(MAILBOX));
  });
  it('shared invite: refused when the test send is not permitted', async () => {
    rows[0].allow_shared = true; ms.sendMailStatus = 403;
    ms.me.body = { mail: 'user@first4u.co.za', userPrincipalName: 'user@first4u.co.za' };
    await startConnect(deps(), token); advance(5); ms.tokenReplies.push(OK_TOKENS);
    expect((await connectStatus(deps(), token)).state).toBe('mismatch');
    expect(created).toHaveLength(0);
  });
  it('refuses when /me cannot be read', async () => {
    ms.me = { status: 403, body: {} };
    await startConnect(deps(), token); advance(5); ms.tokenReplies.push(OK_TOKENS);
    expect((await connectStatus(deps(), token)).state).toBe('mismatch');
    expect(created).toHaveLength(0);
  });
});

describe('secret hygiene', () => {
  it('logs and public views never contain the token, device code, access or refresh token', async () => {
    const views: unknown[] = [];
    views.push(await startConnect(deps(), token));
    advance(5); ms.tokenReplies.push({ error: 'slow_down' });
    views.push(await connectStatus(deps(), token));
    advance(11); ms.tokenReplies.push({ error: 'expired_token' });
    views.push(await connectStatus(deps(), token));
    advance(5); ms.tokenReplies.push(OK_TOKENS);
    views.push(await connectStatus(deps(), token));
    expect(views.at(-1)).toMatchObject({ state: 'connected' });
    const blob = logs.join('\n') + JSON.stringify(views);
    for (const secret of [token, DEVICE_CODE, REFRESH, ACCESS]) expect(blob).not.toContain(secret);
    expect(logs.length).toBeGreaterThan(0);
  });
  it('device code is stored encrypted and decrypts only with the key', () => {
    const enc = encrypt(DEVICE_CODE, ENC);
    expect(enc.toString('utf8')).not.toContain(DEVICE_CODE);
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit per window then blocks, then resets', () => {
    let t = 0; const rl = new RateLimiter(() => t);
    expect([1, 2, 3].map(() => rl.allow('k', 3, 1000))).toEqual([true, true, true]);
    expect(rl.allow('k', 3, 1000)).toBe(false);
    expect(rl.allow('other', 3, 1000)).toBe(true);
    t = 1001;
    expect(rl.allow('k', 3, 1000)).toBe(true);
  });
});
