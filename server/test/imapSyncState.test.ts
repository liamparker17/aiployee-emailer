import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createImapConfig } from '../../packages/core/src/repos/imapConfigs.js';
import { getSyncState, upsertSyncState } from '../../packages/core/src/repos/imapSyncState.js';

const pool = makePool();
const encKey = Buffer.alloc(32, 7);
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function aConfig() {
  const t = await createTenant(pool);
  return createImapConfig(pool, encKey, { tenantId: t.id, senderId: null, host: 'h', port: 993, secure: true, username: 'u', password: 'p', enabled: true });
}

describe('imapSyncState repo', () => {
  it('returns null when no cursor exists yet', async () => {
    const cfg = await aConfig();
    expect(await getSyncState(pool, cfg.id, 'INBOX')).toBeNull();
  });

  it('upserts and reads back the cursor', async () => {
    const cfg = await aConfig();
    await upsertSyncState(pool, cfg.id, 'INBOX', { uidValidity: 42, lastSeenUid: 100 });
    let s = await getSyncState(pool, cfg.id, 'INBOX');
    expect(s).toEqual(expect.objectContaining({ uid_validity: '42', last_seen_uid: '100' }));
    await upsertSyncState(pool, cfg.id, 'INBOX', { uidValidity: 42, lastSeenUid: 250 });
    s = await getSyncState(pool, cfg.id, 'INBOX');
    expect(s?.last_seen_uid).toBe('250');
  });
});
