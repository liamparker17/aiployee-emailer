import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { updatePlayOutcomes } from '../src/repos/agentOutcomes.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function seedSender(tenantId: string): Promise<string> {
  const sc = await pool.query<{ id: string }>(
    `INSERT INTO smtp_configs (tenant_id, name, host, port, username, password_encrypted, from_domain)
     VALUES ($1, 'cfg', 'localhost', 587, 'u', '\\x00'::bytea, 'x.io') RETURNING id`, [tenantId]);
  const s = await pool.query<{ id: string }>(
    `INSERT INTO senders (tenant_id, email, display_name, smtp_config_id, is_default)
     VALUES ($1, 'abe@x.io', 'Abe', $2, true) RETURNING id`, [tenantId, sc.rows[0].id]);
  return s.rows[0].id;
}
async function seedGoal(tenantId: string, spacingDays: number): Promise<string> {
  const g = await pool.query<{ id: string }>(
    `INSERT INTO agent_goals (tenant_id, enabled, touch_spacing_days) VALUES ($1, true, $2) RETURNING id`,
    [tenantId, spacingDays]);
  return g.rows[0].id;
}
// executedDaysAgo controls whether the attribution window has closed.
async function seedExecutingPlay(tenantId: string, goalId: string, executedDaysAgo: number, touchCount: number): Promise<string> {
  const touches = Array.from({ length: touchCount }, (_, i) => ({ index: i, subject: 's', body_html: '<p>h</p>', scheduled_offset_days: i }));
  const p = await pool.query<{ id: string }>(
    `INSERT INTO agent_plays (tenant_id, goal_id, status, executed_at, audience_snapshot, touches)
     VALUES ($1, $2, 'done', now() - make_interval(days => $3), '{"contact_ids":[],"size":1}', $4)
     RETURNING id`,
    [tenantId, goalId, executedDaysAgo, JSON.stringify(touches)]);
  return p.rows[0].id;
}
async function seedOutcomeRow(playId: string, tenantId: string, touchIndex: number, sends: number): Promise<void> {
  await pool.query(
    `INSERT INTO agent_play_outcomes (play_id, tenant_id, touch_index, sends) VALUES ($1, $2, $3, $4)`,
    [playId, tenantId, touchIndex, sends]);
}
async function seedContact(tenantId: string, email: string): Promise<void> {
  await pool.query(`INSERT INTO contacts (tenant_id, email) VALUES ($1, $2)`, [tenantId, email]);
}
async function seedSentEmail(tenantId: string, senderId: string, playId: string, toAddr: string, sentDaysAgo: number): Promise<string> {
  const e = await pool.query<{ id: string }>(
    `INSERT INTO emails (tenant_id, sender_id, to_addr, subject, body_html, status, play_id, sent_at, created_at)
     VALUES ($1, $2, $3, 's', '<p>h</p>', 'sent', $4, now() - make_interval(days => $5), now() - make_interval(days => $5))
     RETURNING id`, [tenantId, senderId, toAddr, playId, sentDaysAgo]);
  return e.rows[0].id;
}
async function seedEvent(emailId: string, tenantId: string, type: 'open' | 'click', daysAgo: number): Promise<void> {
  await pool.query(
    `INSERT INTO email_events (email_id, tenant_id, type, created_at) VALUES ($1, $2, $3, now() - make_interval(days => $4))`,
    [emailId, tenantId, type, daysAgo]);
}

describe('updatePlayOutcomes', () => {
  it('writes play-level numbers into the touch_index=0 row and leaves window open when not elapsed', async () => {
    const t = await createTenant(pool);
    const sender = await seedSender(t.id);
    const goal = await seedGoal(t.id, 3);
    // executed 1 day ago, 2 touches → window closes at executed + 3 + 14 days → still open
    const play = await seedExecutingPlay(t.id, goal, 1, 2);
    await seedOutcomeRow(play, t.id, 0, 1);
    await seedContact(t.id, 'a@x.io');
    const e = await seedSentEmail(t.id, sender, play, 'a@x.io', 1);
    await seedEvent(e, t.id, 'open', 0);

    await updatePlayOutcomes(pool, play);

    const row = await pool.query(
      `SELECT opens, clicks, reactivations, window_closed_at FROM agent_play_outcomes WHERE play_id = $1 AND touch_index = 0`,
      [play]);
    expect(row.rows[0].opens).toBe(1);
    expect(row.rows[0].reactivations).toBe(1);
    expect(row.rows[0].window_closed_at).toBeNull();
  });

  it('sets window_closed_at once the attribution window has fully elapsed', async () => {
    const t = await createTenant(pool);
    const goal = await seedGoal(t.id, 3);
    // executed 60 days ago, 2 touches → executed + 3 + 14 = 17 days ago → window closed
    const play = await seedExecutingPlay(t.id, goal, 60, 2);
    await seedOutcomeRow(play, t.id, 0, 0);

    await updatePlayOutcomes(pool, play);

    const row = await pool.query(
      `SELECT window_closed_at FROM agent_play_outcomes WHERE play_id = $1 AND touch_index = 0`, [play]);
    expect(row.rows[0].window_closed_at).not.toBeNull();
  });

  it('is a no-op (no throw) when no touch_index=0 row exists yet', async () => {
    const t = await createTenant(pool);
    const goal = await seedGoal(t.id, 3);
    const play = await seedExecutingPlay(t.id, goal, 1, 1);
    await expect(updatePlayOutcomes(pool, play)).resolves.toBeUndefined();
  });
});
