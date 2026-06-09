import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { getDefaultSender } from '../src/repos/senders.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function addSender(tenantId: string, email: string, isDefault: boolean) {
  const cfg = await pool.query(
    `INSERT INTO smtp_configs (tenant_id, name, host, port, secure, username, password_encrypted, from_domain)
     VALUES ($1,$2,'h',25,false,'u','\\x00','x.io') RETURNING id`, [tenantId, email]);
  await pool.query(
    `INSERT INTO senders (tenant_id, email, display_name, smtp_config_id, is_default)
     VALUES ($1,$2,'X',$3,$4)`, [tenantId, email, cfg.rows[0].id, isDefault]);
}

describe('getDefaultSender', () => {
  it('returns the default sender, or null when none', async () => {
    const t = await createTenant(pool);
    expect(await getDefaultSender(pool, t.id)).toBeNull();
    await addSender(t.id, 'a@x.io', false);
    await addSender(t.id, 'b@x.io', true);
    const d = await getDefaultSender(pool, t.id);
    expect(d?.email).toBe('b@x.io');
  });
});
