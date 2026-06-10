import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { draftGroupResponse } from '../src/agent/abe/draftGroupResponse.js';
import { createAnalysis, insertReplyGroup, assignRepliesToGroup, getReplyGroup } from '../src/repos/campaignAnalyses.js';
import type { LlmClient } from '../src/agent/runner.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

const ENC = Buffer.alloc(32, 1);
const BASE = 'http://localhost:3000';

async function seed(tenantId: string) {
  const cfg = await pool.query<{ id: string }>(
    `INSERT INTO smtp_configs (tenant_id, name, host, port, secure, username, password_encrypted, from_domain)
     VALUES ($1,'cfg','localhost',587,false,'u','\\x00','x.io') RETURNING id`, [tenantId]);
  const sender = await pool.query<{ id: string }>(
    `INSERT INTO senders (tenant_id, email, display_name, smtp_config_id, is_default)
     VALUES ($1,'from@x.io','X',$2,true) RETURNING id`, [tenantId, cfg.rows[0].id]);
  const c = await pool.query<{ id: string }>(
    `INSERT INTO campaigns(tenant_id, name, status, sender_id, audience_type, audience_id)
     VALUES ($1,'Promo','sent',$2,'list',gen_random_uuid()) RETURNING id`, [tenantId, sender.rows[0].id]);
  const imap = await pool.query<{ id: string }>(
    `INSERT INTO imap_configs (tenant_id, host, username, password_encrypted)
     VALUES ($1,'imap.x.io','u','\\x00') RETURNING id`, [tenantId]);
  await pool.query(
    `INSERT INTO agent_goals (tenant_id, kind, enabled) VALUES ($1, 'reengage_dormant', true)`, [tenantId]);
  return { campaignId: c.rows[0].id, imapConfigId: imap.rows[0].id };
}

async function addMember(
  tenantId: string, imapConfigId: string, campaignId: string, n: number,
  opts: { withContact: boolean; name?: string },
) {
  let contactId: string | null = null;
  if (opts.withContact) {
    const c = await pool.query<{ id: string }>(
      `INSERT INTO contacts(tenant_id, email, name) VALUES ($1,$2,$3) RETURNING id`,
      [tenantId, `lead${n}@x.com`, opts.name ?? `Lead ${n}`]);
    contactId = c.rows[0].id;
  }
  const r = await pool.query<{ id: string }>(
    `INSERT INTO inbound_emails(tenant_id, imap_config_id, imap_uid, message_id, from_addr, from_name, subject, body_text, campaign_id, contact_id)
     VALUES ($1,$2,$3,$4,$5,$6,'Re: Promo',$7,$8,$9) RETURNING id`,
    [tenantId, imapConfigId, n, `<r${n}@x>`, `lead${n}@x.com`, opts.name ?? null, `reply body ${n}`, campaignId, contactId]);
  return { replyId: r.rows[0].id, contactId };
}

async function makeGroup(tenantId: string, campaignId: string, kind: 'standard' | 'hot_leads', memberReplyIds: string[]) {
  const analysis = await createAnalysis(pool, tenantId, campaignId);
  const g = await insertReplyGroup(pool, {
    tenantId, analysisId: analysis.id, label: kind === 'hot_leads' ? 'Hot leads' : 'Opening hours',
    size: memberReplyIds.length, kind,
  });
  await assignRepliesToGroup(pool, tenantId, g.id, memberReplyIds, 'fit');
  return g;
}

describe('draftGroupResponse', () => {
  it('batch mode queues one pending-approval play for all fit members with contacts', async () => {
    const t = await createTenant(pool);
    const { campaignId, imapConfigId } = await seed(t.id);
    const m1 = await addMember(t.id, imapConfigId, campaignId, 1, { withContact: true });
    const m2 = await addMember(t.id, imapConfigId, campaignId, 2, { withContact: true });
    const m3 = await addMember(t.id, imapConfigId, campaignId, 3, { withContact: false });
    const g = await makeGroup(t.id, campaignId, 'standard', [m1.replyId, m2.replyId, m3.replyId]);

    const r = await draftGroupResponse({
      pool, encKey: ENC, baseUrl: BASE, tenantId: t.id, groupId: g.id,
      mode: 'batch', subject: 'Our opening hours', bodyHtml: '<p>We open at 9.</p>',
    });
    expect('error' in r).toBe(false);
    const ok = r as Exclude<typeof r, { error: string }>;
    expect(ok.playIds).toHaveLength(1);
    expect(ok.recipients).toBe(2);
    expect(ok.skippedNoContact).toEqual(['lead3@x.com']);

    const play = await pool.query(`SELECT status, audience_snapshot, touches FROM agent_plays WHERE id=$1`, [ok.playIds[0]]);
    expect(play.rows[0].status).toBe('pending_approval');
    expect(play.rows[0].audience_snapshot.contact_ids.sort()).toEqual([m1.contactId, m2.contactId].sort());
    expect(play.rows[0].touches[0].subject).toBe('Our opening hours');

    const after = await getReplyGroup(pool, t.id, g.id);
    expect(after?.send_mode).toBe('batch');
    expect(after?.draft_status).toBe('queued');
  });

  it('individual mode creates one personalised play per member', async () => {
    const t = await createTenant(pool);
    const { campaignId, imapConfigId } = await seed(t.id);
    const m1 = await addMember(t.id, imapConfigId, campaignId, 1, { withContact: true, name: 'Anna' });
    const m2 = await addMember(t.id, imapConfigId, campaignId, 2, { withContact: true, name: 'Ben' });
    const g = await makeGroup(t.id, campaignId, 'hot_leads', [m1.replyId, m2.replyId]);

    const llm: LlmClient = {
      async chat({ messages }) {
        const who = messages[0].content.includes('Anna') ? 'Anna' : 'Ben';
        return { content: JSON.stringify({ subject: `For ${who}`, body_html: `<p>Hi ${who}</p>` }), toolCalls: [] };
      },
    };
    const r = await draftGroupResponse({
      pool, encKey: ENC, baseUrl: BASE, tenantId: t.id, groupId: g.id,
      mode: 'individual', subject: 'Your quote', bodyHtml: '<p>Quote inside.</p>', llm,
    });
    const ok = r as Exclude<typeof r, { error: string }>;
    expect(ok.playIds).toHaveLength(2);

    const plays = await pool.query(`SELECT status, audience_snapshot, touches FROM agent_plays WHERE tenant_id=$1 ORDER BY created_at`, [t.id]);
    expect(plays.rows).toHaveLength(2);
    const subjects = plays.rows.map((p: any) => p.touches[0].subject).sort();
    expect(subjects).toEqual(['For Anna', 'For Ben']);
    for (const p of plays.rows) {
      expect(p.status).toBe('pending_approval');
      expect(p.audience_snapshot.size).toBe(1);
    }
  });

  it('refuses to batch-draft hot leads', async () => {
    const t = await createTenant(pool);
    const { campaignId, imapConfigId } = await seed(t.id);
    const m1 = await addMember(t.id, imapConfigId, campaignId, 1, { withContact: true });
    const g = await makeGroup(t.id, campaignId, 'hot_leads', [m1.replyId]);

    const r = await draftGroupResponse({
      pool, encKey: ENC, baseUrl: BASE, tenantId: t.id, groupId: g.id,
      mode: 'batch', subject: 's', bodyHtml: '<p>b</p>',
    });
    expect(r).toHaveProperty('error');
  });
});
