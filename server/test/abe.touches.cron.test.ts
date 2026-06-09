import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '@aiployee/core';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { upsertGoal } from '../src/repos/agentGoals.js';
import { insertPlay, getPlay } from '../src/repos/agentPlays.js';

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

async function defSender(tenantId: string) {
  const c = await pool.query(
    `INSERT INTO smtp_configs (tenant_id, name, host, port, secure, username, password_encrypted, from_domain)
     VALUES ($1,'def','h',25,false,'u','\\x00','x.io') RETURNING id`, [tenantId]);
  await pool.query(
    `INSERT INTO senders (tenant_id, email, display_name, smtp_config_id, is_default)
     VALUES ($1,'from@x.io','X',$2,true)`, [tenantId, c.rows[0].id]);
}
async function contact(tenantId: string, email: string) {
  const r = await pool.query(`INSERT INTO contacts (tenant_id, email) VALUES ($1,$2) RETURNING id`, [tenantId, email]);
  return r.rows[0].id as string;
}

describe('POST /v1/cron/abe-touches', () => {
  it('rejects without the cron secret', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/cron/abe-touches' });
    expect(res.statusCode).toBe(401);
  });

  it('queues the next touch, auto-skips re-engaged contacts, and finishes the play', async () => {
    const t = await createTenant(pool);
    await defSender(t.id);
    const a = await contact(t.id, 'a@x.io');
    const b = await contact(t.id, 'b@x.io');
    const reeng = await contact(t.id, 'reeng@x.io');
    // goal with 0-day spacing so touch 1 is immediately due
    const g = await upsertGoal(pool, t.id, { enabled: true, touchSpacingDays: 0 });
    const play = await insertPlay(pool, {
      tenantId: t.id, goalId: g.id, riskScore: 3,
      audienceSnapshot: { contact_ids: [a, b, reeng], size: 3 },
      touches: [
        { index: 0, subject: 'T0', body_html: '<p>0</p>', scheduled_offset_days: 0 },
        { index: 1, subject: 'T1', body_html: '<p>1</p>', scheduled_offset_days: 0 },
      ],
    });
    // simulate touch 0 already executed: mark executing, set executed_at 1h ago, record a touch-0 outcome row
    await pool.query(`UPDATE agent_plays SET status='executing', executed_at = now() - interval '1 hour' WHERE id = $1`, [play.id]);
    await pool.query(`INSERT INTO agent_play_outcomes (play_id, tenant_id, touch_index, sends) VALUES ($1,$2,0,3)`, [play.id, t.id]);
    // reeng opened a play email AFTER executed_at -> should be skipped for touch 1
    const e = await pool.query(
      `INSERT INTO emails (tenant_id, sender_id, to_addr, subject, body_html, status, play_id)
       SELECT $1, s.id, 'reeng@x.io', 's', '<p>b</p>', 'sent', $2 FROM senders s WHERE s.tenant_id = $1 LIMIT 1 RETURNING id`,
      [t.id, play.id]);
    await pool.query(`INSERT INTO email_events (email_id, tenant_id, type, created_at) VALUES ($1,$2,'open', now() - interval '1 minute')`, [e.rows[0].id, t.id]);

    const res = await app.inject({ method: 'POST', url: '/v1/cron/abe-touches', headers: { 'x-cron-secret': 'c'.repeat(24) } });
    expect(res.statusCode).toBe(200);
    expect(res.json().touchesQueued).toBe(2); // a and b, not reeng
    expect(res.json().done).toBe(1);

    const oc = await pool.query(`SELECT sends FROM agent_play_outcomes WHERE play_id=$1 AND touch_index=1`, [play.id]);
    expect(oc.rows[0].sends).toBe(2);
    const queued = await pool.query(`SELECT count(*)::int AS n FROM emails WHERE play_id=$1 AND status='queued'`, [play.id]);
    expect(queued.rows[0].n).toBe(2);
    const updated = await getPlay(pool, t.id, play.id);
    expect(updated?.status).toBe('done');
  });
});
