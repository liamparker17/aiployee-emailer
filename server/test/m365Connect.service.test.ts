import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import {
  createM365Connection,
  getSmtpConfigWithPassword,
  getImapConfigWithPassword,
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
});
