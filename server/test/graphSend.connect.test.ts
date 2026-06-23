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

  it('upgrades existing smtp_config in place — no new row, no UNIQUE name collision', async () => {
    const tenant = await createTenant(pool);

    // Pre-create a password-based smtp_config and a sender pointing at it.
    // The smtp_config name here intentionally matches what Graph connect would try to INSERT
    // (same display-name → would hit smtp_tenant_name_uniq before the fix).
    const oldSmtp = await createSmtpConfig(pool, KEY, {
      tenantId: tenant.id,
      name: 'Acme Graph',   // same name as the Graph connect call below
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      username: 'a@x.com',
      password: 'hunter2',
      fromDomain: 'x.com',
      isDefault: false,
    });
    const oldSender = await createSender(pool, {
      tenantId: tenant.id,
      email: 'a@x.com',
      displayName: 'Acme Old',
      smtpConfigId: oldSmtp.id,
      isDefault: false,
    });

    // Now "reconnect" via Graph — must NOT 500 on the UNIQUE constraint.
    const { sender, smtpConfig } = await createGraphSender(pool, KEY, {
      tenantId: tenant.id,
      username: 'a@x.com',
      name: 'Acme Graph',   // same name → would collide if INSERT was attempted
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

    // Sender id is UNCHANGED — same row, not a new one.
    expect(sender.id).toBe(oldSender.id);

    // smtp_config_id is UNCHANGED — the existing row was upgraded in place.
    expect(smtpConfig.id).toBe(oldSmtp.id);
    expect(sender.smtp_config_id).toBe(oldSmtp.id);

    // The smtp_config is now Graph.
    expect(smtpConfig.auth_type).toBe('graph');

    // getSenderByEmail still resolves to the same smtp_config.
    const fetched = await getSenderByEmail(pool, tenant.id, 'a@x.com');
    expect(fetched!.smtp_config_id).toBe(oldSmtp.id);

    // Refresh token round-trips correctly; old password is gone.
    const full = await getSmtpConfigWithPassword(pool, KEY, tenant.id, smtpConfig.id);
    expect(full!.auth_type).toBe('graph');
    expect(full!.refreshToken).toBe('rt2');
    expect(full!.password).toBeNull();
  });
});
