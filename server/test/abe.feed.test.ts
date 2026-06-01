import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { buildFeed } from '../src/agent/abe/feed.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function seedGoal(tenantId: string): Promise<string> {
  const g = await pool.query<{ id: string }>(
    `INSERT INTO agent_goals (tenant_id, enabled) VALUES ($1, true) RETURNING id`, [tenantId]);
  return g.rows[0].id;
}

describe('buildFeed', () => {
  it('returns [] for a tenant with no plays', async () => {
    const t = await createTenant(pool);
    expect(await buildFeed(pool, t.id)).toEqual([]);
  });

  it('synthesizes a proposed entry for a proposed play', async () => {
    const t = await createTenant(pool);
    const goal = await seedGoal(t.id);
    const p = await pool.query<{ id: string }>(
      `INSERT INTO agent_plays (tenant_id, goal_id, status, audience_snapshot, touches)
       VALUES ($1, $2, 'proposed', '{"contact_ids":[],"size":12}', '[]') RETURNING id`, [t.id, goal]);
    const feed = await buildFeed(pool, t.id);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ playId: p.rows[0].id, kind: 'proposed' });
    expect(feed[0].text).toContain('12');
  });

  it('emits an executed + reported entry (with reactivation %) for a done play with outcomes', async () => {
    const t = await createTenant(pool);
    const goal = await seedGoal(t.id);
    const p = await pool.query<{ id: string }>(
      `INSERT INTO agent_plays (tenant_id, goal_id, status, executed_at, audience_snapshot, touches)
       VALUES ($1, $2, 'done', now() - make_interval(days => 1), '{"contact_ids":[],"size":100}', '[]') RETURNING id`,
      [t.id, goal]);
    await pool.query(
      `INSERT INTO agent_play_outcomes (play_id, tenant_id, touch_index, sends, opens, clicks, reactivations)
       VALUES ($1, $2, 0, 100, 40, 8, 11)`, [p.rows[0].id, t.id]);

    const feed = await buildFeed(pool, t.id);
    const kinds = feed.map((e) => e.kind);
    expect(kinds).toContain('executed');
    expect(kinds).toContain('reported');
    const reported = feed.find((e) => e.kind === 'reported')!;
    expect(reported.text).toContain('11%'); // 11 reactivations / 100 sends
    // reverse-chronological: every entry's `at` is a parseable ISO string, newest first
    const times = feed.map((e) => Date.parse(e.at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});
