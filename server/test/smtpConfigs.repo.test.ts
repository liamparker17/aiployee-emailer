import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createSmtpConfig, listSmtpConfigs, getSmtpConfigWithPassword } from '@aiployee/core';

const KEY = Buffer.alloc(32, 9);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('smtpConfigs repo', () => {
  it('encrypts password and round-trips', async () => {
    const t = await createTenant(pool);
    const c = await createSmtpConfig(pool, KEY, {
      tenantId: t.id, name: 'SES', host: 'email-smtp.eu-west-1.amazonaws.com',
      port: 587, secure: false, username: 'AKIA', password: 'super-secret',
      fromDomain: 'example.com', isDefault: true,
    });
    expect(c.id).toBeTruthy();
    const list = await listSmtpConfigs(pool, t.id);
    expect(list[0]).not.toHaveProperty('password');
    const full = await getSmtpConfigWithPassword(pool, KEY, t.id, c.id);
    expect(full!.password).toBe('super-secret');
  });

  it('isolates tenants', async () => {
    const a = await createTenant(pool); const b = await createTenant(pool);
    await createSmtpConfig(pool, KEY, {
      tenantId: a.id, name: 'A', host: 'h', port: 25, secure: false,
      username: 'u', password: 'p', fromDomain: 'a.com', isDefault: false,
    });
    expect(await listSmtpConfigs(pool, b.id)).toHaveLength(0);
  });
});
