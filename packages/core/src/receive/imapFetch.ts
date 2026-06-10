import type pg from 'pg';
import { getImapConfigWithPassword, setImapConfigError, updateImapRefreshToken } from '../repos/imapConfigs.js';
import { getSyncState, upsertSyncState } from '../repos/imapSyncState.js';
import { insertInboundEmail } from '../repos/inboundEmails.js';
import { parseRawEmail } from './parse.js';
import { correlateReply } from './correlate.js';
import { refreshAccessToken, DEFAULT_MS_CLIENT_ID, DEFAULT_MS_TENANT, type OauthTokens } from './msOauth.js';

const FOLDER = 'INBOX';
const MAX_PER_RUN = 200;

export interface RawMessage { uid: number; source: Buffer }

export interface ImapSession {
  uidValidity: number;
  fetchSince(uid: number): AsyncIterable<RawMessage>;
  close(): Promise<void>;
}

export interface ImapCreds {
  host: string; port: number; secure: boolean; user: string;
  pass?: string;         // auth_type 'password'
  accessToken?: string;  // auth_type 'xoauth2'
}

export type ImapConnect = (creds: ImapCreds) => Promise<ImapSession>;
export type TokenRefresher = (args: { refreshToken: string; clientId?: string; tenant?: string }) => Promise<OauthTokens>;

export interface SyncResult { fetched: number; inserted: number }

/** Build connectable creds for a config, refreshing the OAuth token when needed.
 *  Persists Microsoft's rotated refresh token so the chain never goes stale. */
export async function resolveImapCreds(
  pool: pg.Pool, encKey: Buffer,
  cfg: NonNullable<Awaited<ReturnType<typeof getImapConfigWithPassword>>>,
  refresh: TokenRefresher = refreshAccessToken,
): Promise<ImapCreds> {
  const base = { host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.username };
  if (cfg.auth_type === 'xoauth2') {
    if (!cfg.refreshToken) throw new Error('xoauth2 config has no refresh token — reconnect the mailbox');
    const tokens = await refresh({
      refreshToken: cfg.refreshToken,
      clientId: cfg.oauth_client_id ?? DEFAULT_MS_CLIENT_ID,
      tenant: cfg.oauth_tenant ?? DEFAULT_MS_TENANT,
    });
    if (tokens.refreshToken && tokens.refreshToken !== cfg.refreshToken) {
      await updateImapRefreshToken(pool, encKey, cfg.id, tokens.refreshToken);
    }
    return { ...base, accessToken: tokens.accessToken };
  }
  if (!cfg.password) throw new Error('password config has no stored password');
  return { ...base, pass: cfg.password };
}

export async function syncMailbox(args: {
  pool: pg.Pool;
  encKey: Buffer;
  configId: string;
  connect?: ImapConnect;
  refreshToken?: TokenRefresher;
}): Promise<SyncResult> {
  const { pool, encKey, configId } = args;
  const connect = args.connect ?? imapflowConnect;

  const cfg = await getImapConfigWithPassword(pool, encKey, configId);
  if (!cfg) throw new Error(`imap_config ${configId} not found`);

  let session: ImapSession | null = null;
  try {
    session = await connect(await resolveImapCreds(pool, encKey, cfg, args.refreshToken ?? refreshAccessToken));

    const state = await getSyncState(pool, configId, FOLDER);
    const storedValidity = state ? Number(state.uid_validity) : 0;
    // If UIDVALIDITY changed (or first run), reset the cursor to 0.
    const lastSeen = state && storedValidity === session.uidValidity ? Number(state.last_seen_uid) : 0;

    let fetched = 0;
    let inserted = 0;
    let maxUid = lastSeen;

    for await (const msg of session.fetchSince(lastSeen)) {
      if (fetched >= MAX_PER_RUN) break;
      fetched += 1;
      if (msg.uid > maxUid) maxUid = msg.uid;

      const parsed = await parseRawEmail(msg.source);
      if (!parsed.messageId) continue; // cannot dedup without a Message-ID
      const corr = await correlateReply(pool, cfg.tenant_id, {
        fromAddr: parsed.fromAddr, subject: parsed.subject, inReplyTo: parsed.inReplyTo, references: parsed.references,
      });
      const r = await insertInboundEmail(pool, {
        tenantId: cfg.tenant_id, imapConfigId: configId, imapUid: msg.uid,
        messageId: parsed.messageId, inReplyTo: parsed.inReplyTo, references: parsed.references,
        fromAddr: parsed.fromAddr, fromName: parsed.fromName, toAddr: parsed.toAddr,
        subject: parsed.subject, bodyText: parsed.bodyText, bodyHtml: parsed.bodyHtml, receivedAt: parsed.receivedAt,
        emailId: corr.emailId, campaignId: corr.campaignId, contactId: corr.contactId,
      });
      if (r.inserted) inserted += 1;
    }

    await upsertSyncState(pool, configId, FOLDER, { uidValidity: session.uidValidity, lastSeenUid: maxUid });
    await setImapConfigError(pool, configId, null);
    return { fetched, inserted };
  } catch (e) {
    await setImapConfigError(pool, configId, (e as Error).message);
    throw e;
  } finally {
    if (session) { try { await session.close(); } catch { /* ignore */ } }
  }
}

// Real IMAP adapter (exercised manually / in integration, not in unit tests).
export const imapflowConnect: ImapConnect = async (creds) => {
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({
    host: creds.host, port: creds.port, secure: creds.secure,
    // ImapFlow speaks XOAUTH2 natively when accessToken is set instead of pass.
    auth: creds.accessToken ? { user: creds.user, accessToken: creds.accessToken } : { user: creds.user, pass: creds.pass },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock(FOLDER);
  const uidValidity = Number((client.mailbox && typeof client.mailbox === 'object' ? client.mailbox.uidValidity : 0) ?? 0);
  return {
    uidValidity,
    async *fetchSince(uid: number): AsyncIterable<RawMessage> {
      // UID range: messages with uid greater than the cursor.
      for await (const m of client.fetch({ uid: `${uid + 1}:*` }, { uid: true, source: true })) {
        if (m.uid > uid && m.source) yield { uid: m.uid, source: m.source as Buffer };
      }
    },
    async close() {
      try { lock.release(); } finally { await client.logout(); }
    },
  };
};
