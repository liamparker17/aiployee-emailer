import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { seedInboundCall } from './helpers/lineReport.js';
import { insertCallTag } from '../src/repos/lineCallTags.js';
import {
  listCalls, getCall, sampleInboundContents, deleteTagsForTenant,
  breakdownByCategory, callsPerDay, countCallsMatching,
} from '../src/repos/callAnalytics.js';
import type pg from 'pg';

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

async function seedCall(pool: pg.Pool, tenantId: string, opts: {
  content: string; attribution?: string; outcome?: string; sentiment?: string; resolution?: string;
}): Promise<string> {
  const th = await pool.query<{ id: string }>(
    `INSERT INTO agent_threads (tenant_id, jobix_thread_ref) VALUES ($1, 'jobix:'||gen_random_uuid()) RETURNING id`, [tenantId]);
  const m = await pool.query<{ id: string }>(
    `INSERT INTO agent_messages (thread_id, tenant_id, role, source, content, status)
     VALUES ($1,$2,'inbound','jobix',$3,'sent') RETURNING id`, [th.rows[0].id, tenantId, opts.content]);
  await pool.query(
    `INSERT INTO call_facts (tenant_id, message_id, attribution_label, call_outcome, sentiment, resolution_state)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,'open'))`,
    [tenantId, m.rows[0].id, opts.attribution ?? null, opts.outcome ?? null, opts.sentiment ?? null, opts.resolution ?? null]);
  return m.rows[0].id;
}

describe('listCalls structured filters + sort', () => {
  it('returns structured columns and filters by attribution/outcome/sentiment/resolution', async () => {
    const t = await createTenant(pool);
    await seedCall(pool, t.id, { content: 'arrears query', attribution: 'Accounts', outcome: 'completed', sentiment: 'neutral', resolution: 'open' });
    await seedCall(pool, t.id, { content: 'leak in unit', attribution: 'Maintenance', outcome: 'escalated', sentiment: 'negative', resolution: 'in_progress' });
    const all = await listCalls(pool, t.id, {});
    expect(all.total).toBe(2);
    expect(all.calls[0]).toHaveProperty('attribution_label');
    expect(all.calls[0]).toHaveProperty('resolution_state');
    const acct = await listCalls(pool, t.id, { attribution: 'Accounts' });
    expect(acct.total).toBe(1);
    expect(acct.calls[0].attribution_label).toBe('Accounts');
    expect((await listCalls(pool, t.id, { outcome: 'escalated' })).total).toBe(1);
    expect((await listCalls(pool, t.id, { sentiment: 'negative' })).total).toBe(1);
    expect((await listCalls(pool, t.id, { resolution: 'in_progress' })).total).toBe(1);
  });
  it('sorts by an allow-listed field asc/desc and falls back to created_at on unknown sort', async () => {
    const t = await createTenant(pool);
    await seedCall(pool, t.id, { content: 'a', attribution: 'Zeta' });
    await seedCall(pool, t.id, { content: 'b', attribution: 'Alpha' });
    const asc = await listCalls(pool, t.id, { sort: 'attribution_label', sortDir: 'asc' });
    expect(asc.calls.map(c => c.attribution_label)).toEqual(['Alpha', 'Zeta']);
    const bogus = await listCalls(pool, t.id, { sort: 'DROP TABLE' as never });
    expect(bogus.total).toBe(2);
  });
});
