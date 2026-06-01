import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { lastCompletedPlayOutcome } from '../src/repos/agentOutcomes.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function seedGoal(tenantId: string): Promise<string> {
  const g = await pool.query<{ id: string }>(
    `INSERT INTO agent_goals (tenant_id, enabled) VALUES ($1, true) RETURNING id`, [tenantId]);
  return g.rows[0].id;
}

describe('lastCompletedPlayOutcome', () => {
  it('returns null when the tenant has no completed plays with outcomes', async () => {
    const t = await createTenant(pool);
    expect(await lastCompletedPlayOutcome(pool, t.id)).toBeNull();
  });

  it('summarizes the most recent done play that has recorded sends', async () => {
    const t = await createTenant(pool);
    const goal = await seedGoal(t.id);
    const play = await pool.query<{ id: string }>(
      `INSERT INTO agent_plays (tenant_id, goal_id, status, executed_at, audience_snapshot, touches)
       VALUES ($1, $2, 'done', now() - make_interval(days => 5), '{"contact_ids":[],"size":50}', '[]') RETURNING id`,
      [t.id, goal]);
    await pool.query(
      `INSERT INTO agent_play_outcomes (play_id, tenant_id, touch_index, sends, opens, reactivations)
       VALUES ($1, $2, 0, 50, 20, 6)`, [play.rows[0].id, t.id]);

    const hint = await lastCompletedPlayOutcome(pool, t.id);
    expect(hint).not.toBeNull();
    expect(hint!).toContain('50');
    expect(hint!).toContain('12%'); // 6 / 50 reactivated
  });
});
