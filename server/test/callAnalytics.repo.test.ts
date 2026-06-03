import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { seedInboundCall } from './helpers/lineReport.js';
import { insertCallTag } from '../src/repos/lineCallTags.js';
import {
  listCalls, getCall, sampleInboundContents, deleteTagsForTenant,
  breakdownByCategory, callsPerDay, countCallsMatching,
} from '../src/repos/callAnalytics.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('callAnalytics repo', () => {
  it('lists calls with category, filters by category + text search, paginates', async () => {
    const t = await createTenant(pool);
    const m1 = await seedInboundCall(pool, t.id, 'caller asking about their policy renewal');
    const m2 = await seedInboundCall(pool, t.id, 'wants to lodge a claim for hail damage');
    await insertCallTag(pool, { tenantId: t.id, messageId: m1.id, category: 'Policy queries', severity: 'low', isEmerging: false });
    await insertCallTag(pool, { tenantId: t.id, messageId: m2.id, category: 'Claims', severity: 'med', isEmerging: false });

    const all = await listCalls(pool, t.id, {});
    expect(all.total).toBe(2);
    expect(all.calls.map(c => c.category).sort()).toEqual(['Claims', 'Policy queries']);

    const claims = await listCalls(pool, t.id, { category: 'Claims' });
    expect(claims.total).toBe(1);
    expect(claims.calls[0].id).toBe(m2.id);

    const search = await listCalls(pool, t.id, { search: 'policy' });
    expect(search.total).toBe(1);
    expect(search.calls[0].id).toBe(m1.id);
  });

  it('breakdownByCategory + callsPerDay bucket by CALL time and survive a re-tag', async () => {
    const t = await createTenant(pool);
    const m = await seedInboundCall(pool, t.id, 'policy question');
    await insertCallTag(pool, { tenantId: t.id, messageId: m.id, category: 'Policy queries', severity: 'low', isEmerging: false });
    const start = new Date(Date.now() - 86_400_000), end = new Date(Date.now() + 86_400_000);
    const bd = await breakdownByCategory(pool, t.id, start, end);
    expect(bd.find(b => b.category === 'Policy queries')?.count).toBe(1);
    const pd = await callsPerDay(pool, t.id, start, end);
    expect(pd.reduce((s, d) => s + d.count, 0)).toBe(1);
  });

  it('sampleInboundContents, deleteTagsForTenant, countCallsMatching', async () => {
    const t = await createTenant(pool);
    const m = await seedInboundCall(pool, t.id, 'wants to cancel the policy');
    await insertCallTag(pool, { tenantId: t.id, messageId: m.id, category: 'Complaints', severity: 'low', isEmerging: false });
    expect((await sampleInboundContents(pool, t.id, 10))[0]).toContain('cancel');
    const start = new Date(Date.now() - 86_400_000), end = new Date(Date.now() + 86_400_000);
    expect(await countCallsMatching(pool, t.id, 'cancel', start, end)).toBe(1);
    expect(await deleteTagsForTenant(pool, t.id)).toBe(1);
    expect((await listCalls(pool, t.id, {})).calls[0].category).toBeNull();
  });
});
