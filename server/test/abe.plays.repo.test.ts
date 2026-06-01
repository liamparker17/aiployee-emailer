import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { upsertGoal } from '../src/repos/agentGoals.js';
import { insertPlay, getPlay, listPlays } from '../src/repos/agentPlays.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('agentPlays repo', () => {
  it('inserts a proposed play and reads it back', async () => {
    const t = await createTenant(pool);
    const g = await upsertGoal(pool, t.id, { enabled: true });
    const play = await insertPlay(pool, {
      tenantId: t.id, goalId: g.id, riskScore: 12,
      audienceSnapshot: { contact_ids: ['x'], size: 12 },
      touches: [{ index: 0, subject: 'We miss you', body_html: '<p>hi</p>', scheduled_offset_days: 0 }],
    });
    expect(play.status).toBe('proposed');
    expect(play.risk_score).toBe(12);
    const got = await getPlay(pool, t.id, play.id);
    expect(got?.touches[0].subject).toBe('We miss you');
    const list = await listPlays(pool, t.id);
    expect(list).toHaveLength(1);
  });
});
