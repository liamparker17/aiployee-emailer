import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { findEligibleContacts } from '../src/repos/agentEligible.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function contact(tenantId: string, email: string, subscribed = true) {
  const r = await pool.query(
    `INSERT INTO contacts (tenant_id, email, subscribed) VALUES ($1,$2,$3) RETURNING id`,
    [tenantId, email, subscribed]);
  return r.rows[0].id as string;
}
async function senderId(tenantId: string) {
  const cfg = await pool.query(
    `INSERT INTO smtp_configs (tenant_id, name, host, port, secure, username, password_encrypted, from_domain)
     VALUES ($1,'c','h',25,false,'u','\\x00','x.io') RETURNING id`, [tenantId]);
  const s = await pool.query(
    `INSERT INTO senders (tenant_id, email, display_name, smtp_config_id, is_default)
     VALUES ($1,'from@x.io','X',$2,true) RETURNING id`, [tenantId, cfg.rows[0].id]);
  return s.rows[0].id as string;
}
async function openedAt(tenantId: string, sid: string, toAddr: string, daysAgo: number) {
  const e = await pool.query(
    `INSERT INTO emails (tenant_id, sender_id, to_addr, subject, body_html, status)
     VALUES ($1,$2,$3,'s','<p>b</p>','sent') RETURNING id`, [tenantId, sid, toAddr]);
  await pool.query(
    `INSERT INTO email_events (email_id, tenant_id, type, created_at)
     VALUES ($1,$2,'open', now() - make_interval(days => $3))`, [e.rows[0].id, tenantId, daysAgo]);
}

describe('findEligibleContacts', () => {
  it('drops suppressed, unsubscribed, and (since cutoff) re-engaged contacts', async () => {
    const t = await createTenant(pool);
    const sid = await senderId(t.id);
    const keep = await contact(t.id, 'keep@x.io');
    const unsub = await contact(t.id, 'unsub@x.io', false);
    const supp = await contact(t.id, 'supp@x.io');
    await pool.query(`INSERT INTO suppressions (tenant_id, address, reason) VALUES ($1,'supp@x.io','manual')`, [t.id]);
    const reeng = await contact(t.id, 'reeng@x.io');
    await openedAt(t.id, sid, 'reeng@x.io', 1);

    const ids = [keep, unsub, supp, reeng];
    const cutoff = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    const eligible = await findEligibleContacts(pool, t.id, ids, cutoff);
    expect(eligible.map(c => c.email)).toEqual(['keep@x.io']);

    const noCut = await findEligibleContacts(pool, t.id, ids, null);
    expect(noCut.map(c => c.email).sort()).toEqual(['keep@x.io', 'reeng@x.io']);
  });
});
