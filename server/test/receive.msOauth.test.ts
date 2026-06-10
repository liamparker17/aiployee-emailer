import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { startDeviceCode, pollDeviceCode, refreshAccessToken } from '../../packages/core/src/receive/msOauth.js';
import { createImapConfigOauth, getImapConfigWithPassword } from '../../packages/core/src/repos/imapConfigs.js';
import { syncMailbox, resolveImapCreds, type ImapSession } from '../../packages/core/src/receive/imapFetch.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

const ENC = Buffer.alloc(32, 1);

const fetchStub = (responses: Record<string, unknown>[]) => {
  const calls: { url: string; body: string }[] = [];
  let i = 0;
  const impl = async (url: string, init: { body: string }) => {
    calls.push({ url, body: init.body });
    const payload = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return { ok: true, status: 200, json: async () => payload };
  };
  return { impl: impl as Parameters<typeof startDeviceCode>[0] extends infer _ ? any : never, calls };
};

describe('msOauth device-code flow', () => {
  it('starts, reports pending, then returns tokens', async () => {
    const start = fetchStub([{ device_code: 'dc1', user_code: 'ABC123', verification_uri: 'https://microsoft.com/devicelogin', interval: 5, expires_in: 900 }]);
    const dc = await startDeviceCode({ fetchImpl: start.impl });
    expect(dc.userCode).toBe('ABC123');
    expect(dc.deviceCode).toBe('dc1');
    expect(start.calls[0].url).toContain('/devicecode');
    expect(start.calls[0].body).toContain('IMAP.AccessAsUser.All');

    const poll = fetchStub([
      { error: 'authorization_pending' },
      { access_token: 'at1', refresh_token: 'rt1', expires_in: 3600 },
    ]);
    expect(await pollDeviceCode({ deviceCode: 'dc1', fetchImpl: poll.impl })).toEqual({ status: 'pending' });
    const done = await pollDeviceCode({ deviceCode: 'dc1', fetchImpl: poll.impl });
    expect(done).toEqual({ status: 'ok', tokens: { accessToken: 'at1', refreshToken: 'rt1', expiresInSeconds: 3600 } });
  });

  it('reports declined sign-ins as failed', async () => {
    const poll = fetchStub([{ error: 'authorization_declined', error_description: 'user said no' }]);
    expect(await pollDeviceCode({ deviceCode: 'dc1', fetchImpl: poll.impl })).toEqual({ status: 'failed', error: 'user said no' });
  });

  it('refreshes access tokens', async () => {
    const f = fetchStub([{ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 }]);
    const t = await refreshAccessToken({ refreshToken: 'rt1', fetchImpl: f.impl });
    expect(t.accessToken).toBe('at2');
    expect(f.calls[0].body).toContain('grant_type=refresh_token');
  });
});

describe('xoauth2 imap configs', () => {
  it('stores the refresh token encrypted and resolves creds via token refresh, persisting rotation', async () => {
    const t = await createTenant(pool);
    const cfg = await createImapConfigOauth(pool, ENC, {
      tenantId: t.id, senderId: null, host: 'outlook.office365.com', port: 993, secure: true,
      username: 'marcel@x.com', clientId: 'client-1', oauthTenant: 'common', refreshToken: 'rt-original', enabled: true,
    });
    expect(cfg.auth_type).toBe('xoauth2');

    const raw = await pool.query(`SELECT password_encrypted, oauth_refresh_token_encrypted FROM imap_configs WHERE id=$1`, [cfg.id]);
    expect(raw.rows[0].password_encrypted).toBeNull();
    expect(raw.rows[0].oauth_refresh_token_encrypted).not.toBeNull();
    expect(raw.rows[0].oauth_refresh_token_encrypted.toString()).not.toContain('rt-original');

    const full = (await getImapConfigWithPassword(pool, ENC, cfg.id))!;
    expect(full.refreshToken).toBe('rt-original');
    expect(full.password).toBeNull();

    const seen: string[] = [];
    const creds = await resolveImapCreds(pool, ENC, full, async ({ refreshToken, clientId, tenant }) => {
      seen.push(`${refreshToken}/${clientId}/${tenant}`);
      return { accessToken: 'at-fresh', refreshToken: 'rt-rotated', expiresInSeconds: 3600 };
    });
    expect(creds.accessToken).toBe('at-fresh');
    expect(creds.pass).toBeUndefined();
    expect(seen).toEqual(['rt-original/client-1/common']);

    const after = (await getImapConfigWithPassword(pool, ENC, cfg.id))!;
    expect(after.refreshToken).toBe('rt-rotated');
  });

  it('syncMailbox connects with an access token for xoauth2 configs', async () => {
    const t = await createTenant(pool);
    const cfg = await createImapConfigOauth(pool, ENC, {
      tenantId: t.id, senderId: null, host: 'outlook.office365.com', port: 993, secure: true,
      username: 'marcel@x.com', clientId: 'client-1', oauthTenant: 'common', refreshToken: 'rt1', enabled: true,
    });
    let connectedWith: Record<string, unknown> | null = null;
    const session: ImapSession = {
      uidValidity: 7,
      async *fetchSince() { /* empty inbox */ },
      async close() {},
    };
    const r = await syncMailbox({
      pool, encKey: ENC, configId: cfg.id,
      connect: async creds => { connectedWith = creds as unknown as Record<string, unknown>; return session; },
      refreshToken: async () => ({ accessToken: 'at-live', refreshToken: null, expiresInSeconds: 3600 }),
    });
    expect(r).toEqual({ fetched: 0, inserted: 0 });
    expect(connectedWith).toMatchObject({ user: 'marcel@x.com', accessToken: 'at-live' });
  });
});
