import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import {
  createGraphSender,
  getSmtpConfigWithPassword,
  createSmtpConfig,
  createSender,
  getSenderByEmail,
  listSenders,
} from '@aiployee/core';

const KEY = Buffer.alloc(32, 1);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('createGraphSender', () => {
  it('creates a graph smtp_config and a new sender when none exists', async () => {
    const tenant = await createTenant(pool);

    const { sender, smtpConfig } = await createGraphSender(pool, KEY, {
      tenantId: tenant.id,
      username: 'a@x.com',
      name: 'Acme',
      fromDomain: 'x.com',
      displayName: 'Acme',
      isDefault: true,
      clientId: 'cli',
      oauthTenant: 'common',
      refreshToken: 'rt',
    });

    // smtp_config assertions
    expect(smtpConfig.auth_type).toBe('graph');
    expect(smtpConfig.tenant_id).toBe(tenant.id);
    expect(smtpConfig.username).toBe('a@x.com');

    // sender assertions
    expect(sender.smtp_config_id).toBe(smtpConfig.id);
    expect(sender.email).toBe('a@x.com');

    // password must be null; refresh token must round-trip
    const full = await getSmtpConfigWithPassword(pool, KEY, tenant.id, smtpConfig.id);
    expect(full).not.toBeNull();
    expect(full!.auth_type).toBe('graph');
    expect(full!.password).toBeNull();
    expect(full!.refreshToken).toBe('rt');
  });

  it('upgrades an existing sender to the new graph smtp_config (idempotency)', async () => {
    const tenant = await createTenant(pool);

    // Pre-create a dummy smtp_config (password-based) and a sender pointing at it
    const oldSmtp = await createSmtpConfig(pool, KEY, {
      tenantId: tenant.id,
      name: 'Old SMTP',
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      username: 'a@x.com',
      password: 'hunter2',
      fromDomain: 'x.com',
      isDefault: false,
    });
    await createSender(pool, {
      tenantId: tenant.id,
      email: 'a@x.com',
      displayName: 'Acme Old',
      smtpConfigId: oldSmtp.id,
      isDefault: false,
    });

    // Now upgrade via Graph
    const { sender, smtpConfig } = await createGraphSender(pool, KEY, {
      tenantId: tenant.id,
      username: 'a@x.com',
      name: 'Acme Graph',
      fromDomain: 'x.com',
      displayName: 'Acme',
      isDefault: true,
      clientId: 'cli',
      oauthTenant: 'common',
      refreshToken: 'rt2',
    });

    // Still exactly ONE sender for this email
    const all = await listSenders(pool, tenant.id);
    const forEmail = all.filter(s => s.email === 'a@x.com');
    expect(forEmail).toHaveLength(1);

    // That sender now points at the NEW graph smtp_config
    expect(sender.smtp_config_id).toBe(smtpConfig.id);
    expect(smtpConfig.auth_type).toBe('graph');

    // getSenderByEmail should agree
    const fetched = await getSenderByEmail(pool, tenant.id, 'a@x.com');
    expect(fetched!.smtp_config_id).toBe(smtpConfig.id);

    // Refresh token round-trip
    const full = await getSmtpConfigWithPassword(pool, KEY, tenant.id, smtpConfig.id);
    expect(full!.refreshToken).toBe('rt2');
    expect(full!.password).toBeNull();
  });
});
