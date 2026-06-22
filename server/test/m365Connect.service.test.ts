import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import {
  createM365Connection,
  getSmtpConfigWithPassword,
  getImapConfigWithPassword,
  createImapConfigOauth,
  listImapConfigs,
  listSenders,
} from '@aiployee/core';

const KEY = Buffer.alloc(32, 1);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('createM365Connection', () => {
  it('creates linked SMTP config + sender + IMAP config from a single refresh token', async () => {
    const tenant = await createTenant(pool);

    const { smtpConfig, sender, imapConfig } = await createM365Connection(pool, KEY, {
      tenantId: tenant.id,
      username: 'a@x.com',
      name: 'Acme M365',
      fromDomain: 'x.com',
      displayName: 'Acme',
      isDefault: true,
      clientId: 'cid',
      oauthTenant: 'common',
      refreshToken: 'rt-secret',
    });

    // SMTP config is xoauth2
    expect(smtpConfig.auth_type).toBe('xoauth2');
    expect(smtpConfig.host).toBe('smtp.office365.com');
    expect(smtpConfig.port).toBe(587);
    expect(smtpConfig.username).toBe('a@x.com');

    // Sender is linked to the SMTP config
    expect(sender.smtp_config_id).toBe(smtpConfig.id);
    expect(sender.email).toBe('a@x.com');
    expect(sender.display_name).toBe('Acme');
    expect(sender.is_default).toBe(true);

    // IMAP config is xoauth2 and linked to the sender
    expect(imapConfig.auth_type).toBe('xoauth2');
    expect(imapConfig.sender_id).toBe(sender.id);
    expect(imapConfig.host).toBe('outlook.office365.com');
    expect(imapConfig.port).toBe(993);
    expect(imapConfig.enabled).toBe(true);

    // Both configs share the same refresh token (stored encrypted)
    const smtpFull = await getSmtpConfigWithPassword(pool, KEY, tenant.id, smtpConfig.id);
    expect(smtpFull).not.toBeNull();
    expect(smtpFull!.refreshToken).toBe('rt-secret');

    const imapFull = await getImapConfigWithPassword(pool, KEY, imapConfig.id);
    expect(imapFull).not.toBeNull();
    expect(imapFull!.refreshToken).toBe('rt-secret');
  });

  it('upgrades a pre-existing inbox-only imap_config (no sender) when connecting M365', async () => {
    const tenant = await createTenant(pool);

    // Simulate old inbox-only flow: imap_config exists with no sender
    const oldImap = await createImapConfigOauth(pool, KEY, {
      tenantId: tenant.id,
      senderId: null,
      host: 'outlook.office365.com',
      port: 993,
      secure: true,
      username: 'a@x.com',
      clientId: 'old-cid',
      oauthTenant: 'old-tenant',
      refreshToken: 'old-rt',
      enabled: true,
    });

    // Now connect M365 (full flow)
    const { sender, smtpConfig, imapConfig } = await createM365Connection(pool, KEY, {
      tenantId: tenant.id,
      username: 'a@x.com',
      name: 'Acme M365',
      fromDomain: 'x.com',
      displayName: 'Acme',
      isDefault: true,
      clientId: 'new-cid',
      oauthTenant: 'new-tenant',
      refreshToken: 'new-rt',
    });

    // The imap_config was upgraded in-place (same id), not duplicated
    expect(imapConfig.id).toBe(oldImap.id);
    expect(imapConfig.sender_id).toBe(sender.id);
    expect(imapConfig.auth_type).toBe('xoauth2');
    expect(imapConfig.oauth_client_id).toBe('new-cid');
    expect(imapConfig.oauth_tenant).toBe('new-tenant');
    expect(imapConfig.enabled).toBe(true);

    // The new refresh token is stored
    const imapFull = await getImapConfigWithPassword(pool, KEY, imapConfig.id);
    expect(imapFull!.refreshToken).toBe('new-rt');

    // Exactly ONE imap_config for that tenant+username
    const allImaps = await listImapConfigs(pool, tenant.id);
    const forUsername = allImaps.filter(c => c.username === 'a@x.com');
    expect(forUsername).toHaveLength(1);

    // Sender exists and is linked to smtp
    expect(sender.smtp_config_id).toBe(smtpConfig.id);
    expect(sender.email).toBe('a@x.com');
  });

  it('is idempotent: calling twice for the same email does not throw and leaves one sender + one imap_config', async () => {
    const tenant = await createTenant(pool);

    const first = await createM365Connection(pool, KEY, {
      tenantId: tenant.id,
      username: 'b@x.com',
      name: 'Acme M365',
      fromDomain: 'x.com',
      clientId: 'cid',
      oauthTenant: 'common',
      refreshToken: 'rt-1',
    });

    // Second call must NOT throw (no unique violation)
    const second = await createM365Connection(pool, KEY, {
      tenantId: tenant.id,
      username: 'b@x.com',
      name: 'Acme M365 v2',
      fromDomain: 'x.com',
      clientId: 'cid',
      oauthTenant: 'common',
      refreshToken: 'rt-2',
    });

    // Still exactly ONE sender for that email
    const senders = await listSenders(pool, tenant.id);
    const forEmail = senders.filter(s => s.email === 'b@x.com');
    expect(forEmail).toHaveLength(1);

    // Sender's smtp_config_id points at the LATEST smtp_config
    expect(second.sender.smtp_config_id).toBe(second.smtpConfig.id);
    expect(second.sender.id).toBe(first.sender.id); // same sender row

    // Still exactly ONE imap_config for that username
    const allImaps = await listImapConfigs(pool, tenant.id);
    const forUsername = allImaps.filter(c => c.username === 'b@x.com');
    expect(forUsername).toHaveLength(1);

    // The imap_config has the new refresh token
    const imapFull = await getImapConfigWithPassword(pool, KEY, second.imapConfig.id);
    expect(imapFull!.refreshToken).toBe('rt-2');

    // The imap_config row id is the same as from the first call
    expect(second.imapConfig.id).toBe(first.imapConfig.id);
  });
});
