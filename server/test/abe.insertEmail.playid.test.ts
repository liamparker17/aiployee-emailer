import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { insertEmail } from '@aiployee/core';
import { upsertGoal } from '../src/repos/agentGoals.js';
import { insertPlay } from '../src/repos/agentPlays.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function sender(tenantId: string) {
  const cfg = await pool.query(
    `INSERT INTO smtp_configs (tenant_id, name, host, port, secure, username, password_encrypted, from_domain)
     VALUES ($1,'c','h',25,false,'u','\\x00','x.io') RETURNING id`, [tenantId]);
  const s = await pool.query(
    `INSERT INTO senders (tenant_id, email, display_name, smtp_config_id, is_default)
     VALUES ($1,'from@x.io','X',$2,true) RETURNING id`, [tenantId, cfg.rows[0].id]);
  return s.rows[0].id as string;
}

describe('insertEmail playId', () => {
  it('persists play_id when provided', async () => {
    const t = await createTenant(pool);
    const sid = await sender(t.id);
    const g = await upsertGoal(pool, t.id, { enabled: true });
    const play = await insertPlay(pool, { tenantId: t.id, goalId: g.id, riskScore: 1, audienceSnapshot: { contact_ids: [], size: 0 }, touches: [] });
    const email = await insertEmail(pool, {
      tenantId: t.id, senderId: sid, toAddr: 'a@x.io', subject: 's', bodyHtml: '<p>b</p>', status: 'queued', playId: play.id,
    });
    const row = await pool.query(`SELECT play_id FROM emails WHERE id = $1`, [email.id]);
    expect(row.rows[0].play_id).toBe(play.id);
  });

  it('leaves play_id null when omitted (back-compat)', async () => {
    const t = await createTenant(pool);
    const sid = await sender(t.id);
    const email = await insertEmail(pool, {
      tenantId: t.id, senderId: sid, toAddr: 'a@x.io', subject: 's', bodyHtml: '<p>b</p>', status: 'queued',
    });
    const row = await pool.query(`SELECT play_id FROM emails WHERE id = $1`, [email.id]);
    expect(row.rows[0].play_id).toBeNull();
  });
});
