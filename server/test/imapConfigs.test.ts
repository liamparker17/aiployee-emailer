import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import {
  createImapConfig,
  listEnabledImapConfigs,
  listAllEnabledImapConfigs,
  getImapConfigWithPassword,
} from '../../packages/core/src/repos/imapConfigs.js';

const pool = makePool();
const encKey = Buffer.alloc(32, 7);
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('imapConfigs repo', () => {
  it('creates a config and reads it back with a decrypted password', async () => {
    const t = await createTenant(pool);
    const created = await createImapConfig(pool, encKey, {
      tenantId: t.id, senderId: null, host: 'imap.example.com', port: 993,
      secure: true, username: 'box@example.com', password: 's3cret', enabled: true,
    });
    expect(created.host).toBe('imap.example.com');
    const withPw = await getImapConfigWithPassword(pool, encKey, created.id);
    expect(withPw?.password).toBe('s3cret');
    expect((withPw as Record<string, unknown>).password_encrypted).toBeUndefined();
  });

  it('lists only enabled configs for a tenant and across all tenants', async () => {
    const t = await createTenant(pool);
    await createImapConfig(pool, encKey, { tenantId: t.id, senderId: null, host: 'a', port: 993, secure: true, username: 'a', password: 'p', enabled: true });
    await createImapConfig(pool, encKey, { tenantId: t.id, senderId: null, host: 'b', port: 993, secure: true, username: 'b', password: 'p', enabled: false });
    expect((await listEnabledImapConfigs(pool, t.id)).length).toBe(1);
    expect((await listAllEnabledImapConfigs(pool)).length).toBe(1);
  });
});
