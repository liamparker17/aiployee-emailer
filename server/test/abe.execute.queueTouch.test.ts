import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { upsertGoal } from '../src/repos/agentGoals.js';
import { insertPlay } from '../src/repos/agentPlays.js';
import { getDefaultSender } from '@aiployee/core';
import { queuePlayTouch } from '../src/agent/abe/execute.js';

const pool = makePool();
const encKey = Buffer.alloc(32, 1);
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function defSender(tenantId: string) {
  const cfg = await pool.query(
    `INSERT INTO smtp_configs (tenant_id, name, host, port, secure, username, password_encrypted, from_domain)
     VALUES ($1,'def','h',25,false,'u','\\x00','x.io') RETURNING id`, [tenantId]);
  await pool.query(
    `INSERT INTO senders (tenant_id, email, display_name, smtp_config_id, is_default)
     VALUES ($1,'from@x.io','X',$2,true)`, [tenantId, cfg.rows[0].id]);
  return (await getDefaultSender(pool, tenantId))!;
}
async function contact(tenantId: string, email: string) {
  const r = await pool.query(`INSERT INTO contacts (tenant_id, email) VALUES ($1,$2) RETURNING id`, [tenantId, email]);
  return r.rows[0].id as string;
}

describe('queuePlayTouch', () => {
  it('queues one email per eligible contact, tagged with play_id, and records an outcome row', async () => {
    const t = await createTenant(pool);
    const sender = await defSender(t.id);
    const c1 = await contact(t.id, 'a@x.io');
    const c2 = await contact(t.id, 'b@x.io');
    const g = await upsertGoal(pool, t.id, { enabled: true });
    const play = await insertPlay(pool, {
      tenantId: t.id, goalId: g.id, riskScore: 2,
      audienceSnapshot: { contact_ids: [c1, c2], size: 2 },
      touches: [{ index: 0, subject: 'Miss you', body_html: '<p>come back</p>', scheduled_offset_days: 0 }],
    });

    const res = await queuePlayTouch({ pool, encKey, baseUrl: 'http://localhost', play, touchIndex: 0, sender, reengagedSince: null });
    expect(res.queued).toBe(2);

    const emails = await pool.query(`SELECT play_id, status, body_html FROM emails WHERE tenant_id = $1`, [t.id]);
    expect(emails.rows).toHaveLength(2);
    expect(emails.rows.every(r => r.play_id === play.id)).toBe(true);
    expect(emails.rows.every(r => r.status === 'queued')).toBe(true);
    expect(emails.rows[0].body_html).toContain('unsubscribe');

    const oc = await pool.query(`SELECT touch_index, sends FROM agent_play_outcomes WHERE play_id = $1`, [play.id]);
    expect(oc.rows[0]).toMatchObject({ touch_index: 0, sends: 2 });
  });
});
