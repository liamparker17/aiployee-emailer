// Emailed connection links for Microsoft 365 mailboxes (delegated Graph device-code flow).
//
// An admin creates an invite; the recipient opens /connect/<token>, the server starts a device-code
// flow against the SAME public client + Mail.Send scope the existing /api/m365/graph-send/* routes use,
// and the page just shows the user_code. The device_code never leaves the server. Serverless-safe:
// all flow state lives in the invite row, and each status poll from the page advances the state machine
// by at most one Microsoft token-endpoint call, spaced by the device-code `interval`.
import { createHash, randomBytes } from 'node:crypto';
import { startDeviceCode, DEFAULT_MS_GRAPH_CLIENT_ID, DEFAULT_MS_TENANT } from '../receive/msOauth.js';
import { encrypt, decrypt } from '../crypto/enc.js';

export const INVITE_TTL_MS = 72 * 3600 * 1000;
export const MAX_RESTARTS = 5;
export const MAX_STARTS = 30;
export const MAX_MISMATCHES = 5;

/** Mail.Send + User.Read (to verify the signed-in mailbox via /me). Shared invites also ask for Mail.Send.Shared. */
export const CONNECT_SCOPE = 'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read offline_access';
export const CONNECT_SCOPE_SHARED = 'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Send.Shared https://graph.microsoft.com/User.Read offline_access';
const DEFAULT_VERIFICATION_URI = 'https://microsoft.com/devicelogin';

// ── tokens ──────────────────────────────────────────────────────────────────────────────
export function generateInviteToken(): string { return randomBytes(32).toString('base64url'); }
export function hashInviteToken(token: string): string { return createHash('sha256').update(token, 'utf8').digest('hex'); }
/** Tokens are 43 base64url chars; reject anything else before touching the DB. */
export function looksLikeToken(t: unknown): t is string { return typeof t === 'string' && /^[A-Za-z0-9_-]{43}$/.test(t); }

// ── rate limiting (fixed window, per instance — a coarse net; hard caps live in the invite row) ──
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private now: () => number = Date.now) {}
  /** Returns true if the call is allowed. */
  allow(key: string, limit: number, windowMs: number): boolean {
    const t = this.now();
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.reset <= t) this.hits.delete(k);
    const cur = this.hits.get(key);
    if (!cur || cur.reset <= t) { this.hits.set(key, { n: 1, reset: t + windowMs }); return true; }
    cur.n += 1;
    return cur.n <= limit;
  }
}

// ── storage contract ────────────────────────────────────────────────────────────────────
export type InviteStatus = 'pending' | 'connected' | 'failed' | 'revoked';
export interface InviteRow {
  id: string; tenant_id: string; mailbox: string; recipient_email: string; display_name: string;
  allow_shared: boolean; token_hash: string; status: InviteStatus; expires_at: Date; used_at: Date | null;
  created_by_user_id: string | null; created_by_email: string;
  device_code_enc: Buffer | null; user_code: string | null; verification_uri: string | null;
  device_expires_at: Date | null; poll_interval: number; next_poll_at: Date | null;
  restarts: number; start_count: number; mismatch_count: number; transient_fails: number;
  failure_reason: string | null; sender_id: string | null; connected_at: Date | null; created_at: Date;
}
export type InvitePatch = Partial<Omit<InviteRow, 'id' | 'tenant_id' | 'token_hash' | 'created_at'>>;

export interface InviteStore {
  findByTokenHash(hash: string): Promise<InviteRow | null>;
  getById(id: string): Promise<InviteRow | null>;
  update(id: string, patch: InvitePatch): Promise<void>;
  /** Atomically reserve the next Microsoft poll. True only for the caller that got the slot. */
  claimPoll(id: string, now: Date, nextPollAt: Date): Promise<boolean>;
  /** Atomically mark the invite used/connected. True only if it was still pending and unused. */
  finalize(id: string, now: Date, senderId: string): Promise<boolean>;
}

export type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text?(): Promise<string> }>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface LogLike { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void }

export type ConnectNotice =
  | { kind: 'connected'; signedInAs: string }
  | { kind: 'failed'; reason: 'declined' | 'mismatch' | 'error' | 'too_many_attempts'; signedInAs?: string };

export interface ConnectDeps {
  store: InviteStore;
  encKey: Buffer;
  fetchImpl: FetchLike;
  now?: () => Date;
  log: LogLike;
  /** Create/upgrade the sender exactly like POST /api/m365/graph-send/complete. */
  createSender(inv: InviteRow, refreshToken: string): Promise<{ senderId: string }>;
  /** Best-effort admin notification. Must not throw (errors are swallowed). */
  notify(inv: InviteRow, n: ConnectNotice): Promise<void>;
  clientId?: string;
  oauthTenant?: string;
}

export type PublicView =
  | { state: 'invalid' }
  | { state: 'expired' }
  | { state: 'used' }
  | { state: 'needs_start' }
  | { state: 'waiting'; mailbox: string; userCode: string; verificationUri: string; expiresAt: string; restarted?: boolean }
  | { state: 'connected'; mailbox: string }
  | { state: 'mismatch'; mailbox: string; message: string }
  | { state: 'declined'; message: string }
  | { state: 'failed'; message: string };

const nowOf = (d: ConnectDeps) => (d.now ? d.now() : new Date());

function safeVerificationUri(u: string): string {
  try {
    const p = new URL(u);
    if (p.protocol === 'https:' && (p.hostname === 'microsoft.com' || p.hostname === 'www.microsoft.com' || p.hostname === 'login.microsoftonline.com' || p.hostname === 'login.microsoft.com')) return p.toString();
  } catch { /* fall through */ }
  return DEFAULT_VERIFICATION_URI;
}

/** Look the invite up and apply the generic lifecycle checks. Never reveals mailbox data. */
async function resolve(d: ConnectDeps, token: unknown): Promise<{ inv: InviteRow } | { view: PublicView }> {
  if (!looksLikeToken(token)) return { view: { state: 'invalid' } };
  const inv = await d.store.findByTokenHash(hashInviteToken(token));
  if (!inv || inv.status === 'revoked') return { view: { state: 'invalid' } };
  if (inv.used_at || inv.status === 'connected') return { view: { state: 'used' } };
  if (inv.expires_at.getTime() <= nowOf(d).getTime()) return { view: { state: 'expired' } };
  if (inv.status === 'failed') return { view: { state: 'failed', message: 'This link can no longer be used. Please ask for a new one.' } };
  return { inv };
}

function waitingView(inv: InviteRow, restarted = false): PublicView {
  return {
    state: 'waiting', mailbox: inv.mailbox, userCode: inv.user_code ?? '',
    verificationUri: inv.verification_uri ?? DEFAULT_VERIFICATION_URI,
    expiresAt: (inv.device_expires_at ?? new Date()).toISOString(), restarted,
  };
}

const flowActive = (inv: InviteRow, now: Date) =>
  !!(inv.device_code_enc && inv.user_code && inv.device_expires_at && inv.device_expires_at.getTime() > now.getTime());

async function beginFlow(d: ConnectDeps, inv: InviteRow, isRestart: boolean): Promise<InviteRow | PublicView> {
  if (inv.start_count >= MAX_STARTS || (isRestart && inv.restarts >= MAX_RESTARTS)) {
    await d.store.update(inv.id, { status: 'failed', failure_reason: 'too_many_attempts', device_code_enc: null, user_code: null });
    await safeNotify(d, inv, { kind: 'failed', reason: 'too_many_attempts' });
    return { state: 'failed', message: 'Too many attempts. Please ask for a new link.' };
  }
  let dc;
  try {
    dc = await startDeviceCode({
      clientId: d.clientId ?? DEFAULT_MS_GRAPH_CLIENT_ID,
      tenant: d.oauthTenant ?? DEFAULT_MS_TENANT,
      scope: inv.allow_shared ? CONNECT_SCOPE_SHARED : CONNECT_SCOPE,
      fetchImpl: d.fetchImpl as never,
    });
  } catch {
    d.log.warn({ inviteId: inv.id }, 'connect: device code start failed');
    return { state: 'failed', message: 'We could not reach Microsoft. Please reload this page in a minute.' };
  }
  const now = nowOf(d);
  const patch: InvitePatch = {
    device_code_enc: encrypt(dc.deviceCode, d.encKey), user_code: dc.userCode,
    verification_uri: safeVerificationUri(dc.verificationUri),
    device_expires_at: new Date(now.getTime() + dc.expiresInSeconds * 1000),
    poll_interval: Math.max(dc.intervalSeconds, 1),
    next_poll_at: new Date(now.getTime() + Math.max(dc.intervalSeconds, 1) * 1000),
    start_count: inv.start_count + 1, restarts: inv.restarts + (isRestart ? 1 : 0),
  };
  await d.store.update(inv.id, patch);
  return { ...inv, ...patch };
}

const isView = (x: InviteRow | PublicView): x is PublicView => 'state' in x;

/** Public: validate the token and (idempotently) start the device-code flow. */
export async function startConnect(d: ConnectDeps, token: unknown): Promise<PublicView> {
  const r = await resolve(d, token);
  if ('view' in r) return r.view;
  let inv = r.inv;
  if (flowActive(inv, nowOf(d))) return waitingView(inv);
  const began = await beginFlow(d, inv, false);
  if (isView(began)) return began;
  inv = began;
  return waitingView(inv);
}

type Poll =
  | { kind: 'ok'; accessToken: string; refreshToken: string | null }
  | { kind: 'pending' } | { kind: 'transient' } | { kind: 'slow_down' } | { kind: 'expired' } | { kind: 'declined' } | { kind: 'error' };

async function pollMicrosoft(d: ConnectDeps, deviceCode: string): Promise<Poll> {
  const url = `https://login.microsoftonline.com/${encodeURIComponent(d.oauthTenant ?? DEFAULT_MS_TENANT)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: d.clientId ?? DEFAULT_MS_GRAPH_CLIENT_ID, device_code: deviceCode,
  }).toString();
  let j: Record<string, unknown>;
  try {
    const res = await d.fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    j = (await res.json()) as Record<string, unknown>;
  } catch { return { kind: 'transient' }; } // network error / non-JSON body: back off and retry
  if (typeof j.access_token === 'string') {
    return { kind: 'ok', accessToken: j.access_token, refreshToken: typeof j.refresh_token === 'string' ? j.refresh_token : null };
  }
  switch (String(j.error ?? '')) {
    case 'authorization_pending': return { kind: 'pending' };
    case 'temporarily_unavailable': case 'server_error': case 'service_unavailable': return { kind: 'transient' };
    case 'slow_down': return { kind: 'slow_down' };
    case 'expired_token': return { kind: 'expired' };
    case 'authorization_declined': case 'access_denied': return { kind: 'declined' };
    default: return { kind: 'error' };
  }
}

async function graphMe(d: ConnectDeps, accessToken: string): Promise<{ mail: string | null; upn: string | null } | null> {
  try {
    const res = await d.fetchImpl('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { mail?: string | null; userPrincipalName?: string | null };
    return { mail: j.mail ?? null, upn: j.userPrincipalName ?? null };
  } catch { return null; }
}

/** Single test message FROM the mailbox TO the mailbox itself — proves Send As without touching anyone else. */
async function testSendAs(d: ConnectDeps, accessToken: string, mailbox: string): Promise<boolean> {
  try {
    const res = await d.fetchImpl(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject: 'Aiployee connection test',
          body: { contentType: 'Text', content: 'This is an automated Aiployee connection test confirming this mailbox can be used to send email. No action is needed.' },
          toRecipients: [{ emailAddress: { address: mailbox } }],
        },
        saveToSentItems: false,
      }),
    });
    return res.status === 202;
  } catch { return false; }
}

async function safeNotify(d: ConnectDeps, inv: InviteRow, n: ConnectNotice) {
  try { await d.notify(inv, n); } catch { d.log.warn({ inviteId: inv.id }, 'connect: admin notification failed'); }
}

/** Public: advance the flow by at most one Microsoft poll and report the state. */
export async function connectStatus(d: ConnectDeps, token: unknown): Promise<PublicView> {
  const r = await resolve(d, token);
  if ('view' in r) return r.view;
  let inv = r.inv;
  const now = nowOf(d);
  if (!inv.device_code_enc || !inv.user_code) return { state: 'needs_start' };

  // The device code lapsed before anyone finished: issue a fresh one automatically.
  if (!flowActive(inv, now)) {
    const began = await beginFlow(d, inv, true);
    if (isView(began)) return began;
    return waitingView(began, true);
  }
  if (inv.next_poll_at && inv.next_poll_at.getTime() > now.getTime()) return waitingView(inv);
  const next = new Date(now.getTime() + inv.poll_interval * 1000);
  if (!(await d.store.claimPoll(inv.id, now, next))) return waitingView(inv);

  const deviceCode = decrypt(inv.device_code_enc, d.encKey);
  const p = await pollMicrosoft(d, deviceCode);

  switch (p.kind) {
    case 'pending':
      if (inv.transient_fails > 0) await d.store.update(inv.id, { transient_fails: 0 });
      return waitingView(inv);
    case 'transient': {
      // Exponential backoff on the next poll only (interval itself is left alone), capped at 60s.
      const fails = Math.min(inv.transient_fails + 1, 5);
      const wait = Math.min(60, inv.poll_interval * 2 ** fails);
      await d.store.update(inv.id, { transient_fails: fails, next_poll_at: new Date(now.getTime() + wait * 1000) });
      return waitingView(inv);
    }
    case 'slow_down': {
      const interval = inv.poll_interval + 5;
      const patch = { poll_interval: interval, next_poll_at: new Date(now.getTime() + interval * 1000) };
      await d.store.update(inv.id, patch);
      return waitingView({ ...inv, ...patch });
    }
    case 'expired': {
      const began = await beginFlow(d, inv, true);
      if (isView(began)) return began;
      return waitingView(began, true);
    }
    case 'declined':
      return fail(d, inv, 'declined');
    case 'error': {
      const fresh = await d.store.getById(inv.id);
      if (fresh?.used_at) return { state: 'used' }; // a parallel tab already finished it
      return fail(d, inv, 'error');
    }
    case 'ok':
      return complete(d, inv, p.accessToken, p.refreshToken);
  }
}

async function fail(d: ConnectDeps, inv: InviteRow, reason: 'declined' | 'error'): Promise<PublicView> {
  await d.store.update(inv.id, { status: 'failed', failure_reason: reason, device_code_enc: null, user_code: null });
  await safeNotify(d, inv, { kind: 'failed', reason });
  d.log.info({ inviteId: inv.id, reason }, 'connect: invite failed');
  return reason === 'declined'
    ? { state: 'declined', message: 'Access was declined, so nothing was connected. If that was a mistake, ask for a new link.' }
    : { state: 'failed', message: 'Microsoft sign-in did not complete. Please ask for a new link.' };
}

async function complete(d: ConnectDeps, inv: InviteRow, accessToken: string, refreshToken: string | null): Promise<PublicView> {
  if (!refreshToken) return fail(d, inv, 'error');
  const me = await graphMe(d, accessToken);
  // UPN only. `mail` is an admin-editable directory attribute (nOAuth), so it never counts on its own.
  const want = inv.mailbox.trim().toLowerCase();
  const signedInAs = me?.upn ?? me?.mail ?? undefined;
  let accepted = !!me?.upn && me.upn.trim().toLowerCase() === want;
  // A different account (e.g. a delegate of a shared mailbox) is accepted only if invited as shared
  // AND a real sendMail as the mailbox succeeds.
  if (!accepted && inv.allow_shared) accepted = await testSendAs(d, accessToken, want);

  if (!accepted) {
    const mismatches = inv.mismatch_count + 1;
    const tooMany = mismatches >= MAX_MISMATCHES;
    await d.store.update(inv.id, {
      mismatch_count: mismatches, device_code_enc: null, user_code: null, device_expires_at: null, next_poll_at: null,
      ...(tooMany ? { status: 'failed' as const, failure_reason: 'mismatch' } : {}),
    });
    await safeNotify(d, inv, { kind: 'failed', reason: 'mismatch', signedInAs });
    d.log.info({ inviteId: inv.id, reason: 'mismatch' }, 'connect: signed-in account did not match');
    return {
      state: 'mismatch', mailbox: inv.mailbox,
      message: `You signed in with a different account than ${inv.mailbox}, so nothing was connected. Please start again and sign in as ${inv.mailbox}.`,
    };
  }

  // Re-check the invite right before writing anything: it may have been revoked or expired mid-flow.
  const fresh = await d.store.getById(inv.id);
  if (!fresh || fresh.status !== 'pending' || fresh.used_at || fresh.expires_at.getTime() <= nowOf(d).getTime()) {
    return fresh?.used_at || fresh?.status === 'connected' ? { state: 'used' } : { state: 'invalid' };
  }

  let senderId: string;
  try { ({ senderId } = await d.createSender(inv, refreshToken)); }
  catch {
    d.log.error({ inviteId: inv.id }, 'connect: creating sender failed');
    return fail(d, inv, 'error');
  }
  const done = await d.store.finalize(inv.id, nowOf(d), senderId);
  await d.store.update(inv.id, { device_code_enc: null, user_code: null });
  if (done) await safeNotify(d, inv, { kind: 'connected', signedInAs: signedInAs ?? inv.mailbox });
  d.log.info({ inviteId: inv.id }, 'connect: mailbox connected');
  return { state: 'connected', mailbox: inv.mailbox };
}
