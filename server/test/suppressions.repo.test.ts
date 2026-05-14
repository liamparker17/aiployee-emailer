import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { isSuppressed, addSuppression, listSuppressions, removeSuppression } from '../src/repos/suppressions.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('suppressions repo', () => {
  it('round-trips and matches case-insensitively', async () => {
    const t = await createTenant(pool);
    expect(await isSuppressed(pool, t.id, 'X@Y.com')).toBe(false);
    await addSuppression(pool, { tenantId: t.id, address: 'X@Y.com', reason: 'manual' });
    expect(await isSuppressed(pool, t.id, 'x@y.com')).toBe(true);
    expect(await isSuppressed(pool, t.id, 'X@Y.COM')).toBe(true);
    const list = await listSuppressions(pool, t.id);
    expect(list).toHaveLength(1);
    expect(list[0].address).toBe('x@y.com');
    expect(list[0].reason).toBe('manual');
  });

  it('upsert is idempotent', async () => {
    const t = await createTenant(pool);
    await addSuppression(pool, { tenantId: t.id, address: 'a@b.com', reason: 'manual' });
    await addSuppression(pool, { tenantId: t.id, address: 'a@b.com', reason: 'bounce' });
    const list = await listSuppressions(pool, t.id);
    expect(list).toHaveLength(1);
  });

  it('isolates tenants', async () => {
    const t1 = await createTenant(pool);
    const t2 = await createTenant(pool);
    await addSuppression(pool, { tenantId: t1.id, address: 'a@b.com', reason: 'manual' });
    expect(await isSuppressed(pool, t1.id, 'a@b.com')).toBe(true);
    expect(await isSuppressed(pool, t2.id, 'a@b.com')).toBe(false);
  });

  it('remove returns true when row deleted', async () => {
    const t = await createTenant(pool);
    await addSuppression(pool, { tenantId: t.id, address: 'a@b.com', reason: 'manual' });
    expect(await removeSuppression(pool, t.id, 'A@B.com')).toBe(true);
    expect(await removeSuppression(pool, t.id, 'a@b.com')).toBe(false);
  });
});
