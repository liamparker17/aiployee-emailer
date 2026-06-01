import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { upsertGoal } from '../src/repos/agentGoals.js';
import { insertPlay, getPlay } from '../src/repos/agentPlays.js';
import { startPlayExecution } from '../src/agent/abe/execute.js';

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
}
async function contact(tenantId: string, email: string) {
  const r = await pool.query(`INSERT INTO contacts (tenant_id, email) VALUES ($1,$2) RETURNING id`, [tenantId, email]);
  return r.rows[0].id as string;
}
async function proposedPlay(tenantId: string, contactIds: string[]) {
  const g = await upsertGoal(pool, tenantId, { enabled: true });
  return insertPlay(pool, {
    tenantId, goalId: g.id, riskScore: contactIds.length,
    audienceSnapshot: { contact_ids: contactIds, size: contactIds.length },
    touches: [{ index: 0, subject: 'Miss you', body_html: '<p>hi</p>', scheduled_offset_days: 0 }],
  });
}

describe('startPlayExecution', () => {
  it('marks the play executing, sets executed_at, and queues touch 0', async () => {
    const t = await createTenant(pool);
    await defSender(t.id);
    const c1 = await contact(t.id, 'a@x.io');
    const c2 = await contact(t.id, 'b@x.io');
    const play = await proposedPlay(t.id, [c1, c2]);

    const res = await startPlayExecution({ pool, encKey, baseUrl: 'http://localhost', play });
    expect(res.queued).toBe(2);

    const updated = await getPlay(pool, t.id, play.id);
    expect(updated?.status).toBe('executing');
    expect(updated?.executed_at).not.toBeNull();

    const emails = await pool.query(`SELECT count(*)::int AS n FROM emails WHERE play_id = $1`, [play.id]);
    expect(emails.rows[0].n).toBe(2);
  });

  it('throws no_sender when the tenant has no default sender', async () => {
    const t = await createTenant(pool);
    const c1 = await contact(t.id, 'a@x.io');
    const play = await proposedPlay(t.id, [c1]);
    await expect(startPlayExecution({ pool, encKey, baseUrl: 'http://localhost', play })).rejects.toThrow('no_sender');
  });
});
