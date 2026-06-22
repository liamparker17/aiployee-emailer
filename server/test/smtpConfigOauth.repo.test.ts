import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createSmtpConfigOauth, getSmtpConfigWithPassword } from '@aiployee/core';

const KEY = Buffer.alloc(32, 1);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('smtpConfigOauth repo', () => {
  it('stores refresh token encrypted and round-trips via getSmtpConfigWithPassword', async () => {
    const t = await createTenant(pool);
    const cfg = await createSmtpConfigOauth(pool, KEY, {
      tenantId: t.id,
      name: 'M365',
      host: 'smtp.office365.com',
      port: 587,
      secure: false,
      username: 'a@x.com',
      fromDomain: 'x.com',
      isDefault: true,
      clientId: 'cid',
      oauthTenant: 'common',
      refreshToken: 'rt-secret',
    });

    expect(cfg.id).toBeTruthy();
    expect(cfg.auth_type).toBe('xoauth2');
    expect(cfg.oauth_client_id).toBe('cid');

    const full = await getSmtpConfigWithPassword(pool, KEY, t.id, cfg.id);
    expect(full).not.toBeNull();
    expect(full!.password).toBeNull();
    expect(full!.refreshToken).toBe('rt-secret');
    expect(full!.auth_type).toBe('xoauth2');
  });
});
