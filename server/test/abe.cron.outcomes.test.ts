import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';

const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
  CRON_SECRET: 'c'.repeat(24),
});

let app: Awaited<ReturnType<typeof buildApp>>;
const pool = makePool();

beforeAll(async () => { app = await buildApp({ cfg }); });
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await pool.end(); });

async function seedSender(tenantId: string): Promise<string> {
  const sc = await pool.query<{ id: string }>(
    `INSERT INTO smtp_configs (tenant_id, name, host, port, username, password_encrypted, from_domain)
     VALUES ($1, 'cfg', 'localhost', 587, 'u', '\\x00'::bytea, 'x.io') RETURNING id`, [tenantId]);
  const s = await pool.query<{ id: string }>(
    `INSERT INTO senders (tenant_id, email, display_name, smtp_config_id, is_default)
     VALUES ($1, 'abe@x.io', 'Abe', $2, true) RETURNING id`, [tenantId, sc.rows[0].id]);
  return s.rows[0].id;
}

describe('POST /v1/cron/abe-outcomes', () => {
  it('rejects without the cron secret', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/cron/abe-outcomes' });
    expect(res.statusCode).toBe(401);
  });

  it('rolls up outcomes for an executing play', async () => {
    const t = await createTenant(pool);
    const sender = await seedSender(t.id);
    const goal = await pool.query<{ id: string }>(
      `INSERT INTO agent_goals (tenant_id, enabled, touch_spacing_days) VALUES ($1, true, 3) RETURNING id`, [t.id]);
    const play = await pool.query<{ id: string }>(
      `INSERT INTO agent_plays (tenant_id, goal_id, status, executed_at, audience_snapshot, touches)
       VALUES ($1, $2, 'executing', now() - make_interval(days => 1), '{"contact_ids":[],"size":1}',
               '[{"index":0,"subject":"s","body_html":"<p>h</p>","scheduled_offset_days":0}]')
       RETURNING id`, [t.id, goal.rows[0].id]);
    await pool.query(
      `INSERT INTO agent_play_outcomes (play_id, tenant_id, touch_index, sends) VALUES ($1, $2, 0, 1)`,
      [play.rows[0].id, t.id]);
    await pool.query(`INSERT INTO contacts (tenant_id, email) VALUES ($1, 'a@x.io')`, [t.id]);
    const email = await pool.query<{ id: string }>(
      `INSERT INTO emails (tenant_id, sender_id, to_addr, subject, body_html, status, play_id, sent_at)
       VALUES ($1, $2, 'a@x.io', 's', '<p>h</p>', 'sent', $3, now() - make_interval(days => 1)) RETURNING id`,
      [t.id, sender, play.rows[0].id]);
    await pool.query(
      `INSERT INTO email_events (email_id, tenant_id, type) VALUES ($1, $2, 'open')`, [email.rows[0].id, t.id]);

    const res = await app.inject({
      method: 'POST', url: '/v1/cron/abe-outcomes', headers: { 'x-cron-secret': 'c'.repeat(24) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().updated).toBe(1);

    const row = await pool.query(
      `SELECT opens, reactivations FROM agent_play_outcomes WHERE play_id = $1 AND touch_index = 0`,
      [play.rows[0].id]);
    expect(row.rows[0].opens).toBe(1);
    expect(row.rows[0].reactivations).toBe(1);
  });
});
