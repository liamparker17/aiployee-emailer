import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { aggregatePlayEngagement, ATTRIBUTION_DAYS } from '../src/repos/agentOutcomes.js';

const pool = makePool();

beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

// Minimal sender chain: emails.sender_id and senders.smtp_config_id are NOT NULL.
async function seedSender(tenantId: string): Promise<string> {
  const sc = await pool.query<{ id: string }>(
    `INSERT INTO smtp_configs (tenant_id, name, host, port, username, password_encrypted, from_domain)
     VALUES ($1, 'cfg', 'localhost', 587, 'u', '\\x00'::bytea, 'x.io') RETURNING id`,
    [tenantId],
  );
  const s = await pool.query<{ id: string }>(
    `INSERT INTO senders (tenant_id, email, display_name, smtp_config_id, is_default)
     VALUES ($1, 'abe@x.io', 'Abe', $2, true) RETURNING id`,
    [tenantId, sc.rows[0].id],
  );
  return s.rows[0].id;
}

async function seedGoal(tenantId: string): Promise<string> {
  const g = await pool.query<{ id: string }>(
    `INSERT INTO agent_goals (tenant_id, enabled) VALUES ($1, true) RETURNING id`, [tenantId]);
  return g.rows[0].id;
}

async function seedPlay(tenantId: string, goalId: string): Promise<string> {
  const p = await pool.query<{ id: string }>(
    `INSERT INTO agent_plays (tenant_id, goal_id, status, executed_at, audience_snapshot, touches)
     VALUES ($1, $2, 'done', now() - make_interval(days => 1), '{"contact_ids":[],"size":2}', '[]')
     RETURNING id`,
    [tenantId, goalId],
  );
  return p.rows[0].id;
}

// Insert a play-tagged, already-sent email to a contact; returns the email id.
async function seedSentEmail(
  tenantId: string, senderId: string, playId: string, toAddr: string, sentDaysAgo: number,
): Promise<string> {
  const e = await pool.query<{ id: string }>(
    `INSERT INTO emails (tenant_id, sender_id, to_addr, subject, body_html, status, play_id, sent_at, created_at)
     VALUES ($1, $2, $3, 's', '<p>h</p>', 'sent', $4, now() - make_interval(days => $5), now() - make_interval(days => $5))
     RETURNING id`,
    [tenantId, senderId, toAddr, playId, sentDaysAgo],
  );
  return e.rows[0].id;
}

async function seedEvent(emailId: string, tenantId: string, type: 'open' | 'click', daysAgo: number): Promise<void> {
  await pool.query(
    `INSERT INTO email_events (email_id, tenant_id, type, created_at)
     VALUES ($1, $2, $3, now() - make_interval(days => $4))`,
    [emailId, tenantId, type, daysAgo],
  );
}

async function seedContact(tenantId: string, email: string): Promise<void> {
  await pool.query(`INSERT INTO contacts (tenant_id, email) VALUES ($1, $2)`, [tenantId, email]);
}

describe('aggregatePlayEngagement', () => {
  it('exposes a 14-day attribution constant', () => {
    expect(ATTRIBUTION_DAYS).toBe(14);
  });

  it('counts sends, opens/clicks (total + unique), and reactivations within the window', async () => {
    const t = await createTenant(pool);
    const sender = await seedSender(t.id);
    const goal = await seedGoal(t.id);
    const play = await seedPlay(t.id, goal);

    await seedContact(t.id, 'A@x.io');   // mixed case → case-insensitive match
    await seedContact(t.id, 'b@x.io');
    await seedContact(t.id, 'c@x.io');    // never engaged

    const eA = await seedSentEmail(t.id, sender, play, 'a@x.io', 1); // sent 1 day ago
    const eB = await seedSentEmail(t.id, sender, play, 'b@x.io', 1);
    await seedSentEmail(t.id, sender, play, 'c@x.io', 1);

    // A opens twice (2 opens, 1 unique email) + clicks once → reactivated
    await seedEvent(eA, t.id, 'open', 0);
    await seedEvent(eA, t.id, 'open', 0);
    await seedEvent(eA, t.id, 'click', 0);
    // B opens once → reactivated
    await seedEvent(eB, t.id, 'open', 0);

    const r = await aggregatePlayEngagement(pool, play);
    expect(r.sent).toBe(3);
    expect(r.opens).toBe(3);        // 2 from A + 1 from B
    expect(r.uniqueOpens).toBe(2);  // eA, eB
    expect(r.clicks).toBe(1);
    expect(r.uniqueClicks).toBe(1);
    expect(r.reactivations).toBe(2); // contacts A and B
  });

  it('excludes engagement that falls outside the 14-day window', async () => {
    const t = await createTenant(pool);
    const sender = await seedSender(t.id);
    const goal = await seedGoal(t.id);
    const play = await seedPlay(t.id, goal);
    await seedContact(t.id, 'late@x.io');

    const e = await seedSentEmail(t.id, sender, play, 'late@x.io', 30); // sent 30 days ago
    await seedEvent(e, t.id, 'open', 0); // opened today = 30 days after send → outside window

    const r = await aggregatePlayEngagement(pool, play);
    expect(r.sent).toBe(1);
    expect(r.opens).toBe(1);        // raw opens still counted
    expect(r.reactivations).toBe(0); // but NOT a reactivation (outside attribution window)
  });
});
