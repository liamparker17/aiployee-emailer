import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { analyzeCampaign } from '../src/agent/abe/campaignAnalysis.js';
import { campaignFunnel, latestAnalysis, listReplyGroups } from '../src/repos/campaignAnalyses.js';
import type { LlmClient } from '../src/agent/runner.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

// Orthogonal unit vectors: same index → cosine 1, different → 0. Lets the test
// steer the deterministic clustering exactly.
const vec = (i: number): number[] => { const v = new Array(1536).fill(0); v[i] = 1; return v; };

async function seedCampaign(tenantId: string) {
  const cfg = await pool.query<{ id: string }>(
    `INSERT INTO smtp_configs (tenant_id, name, host, port, secure, username, password_encrypted, from_domain)
     VALUES ($1,'cfg','localhost',587,false,'u','\\x00','x.io') RETURNING id`, [tenantId]);
  const sender = await pool.query<{ id: string }>(
    `INSERT INTO senders (tenant_id, email, display_name, smtp_config_id, is_default)
     VALUES ($1,'from@x.io','X',$2,true) RETURNING id`, [tenantId, cfg.rows[0].id]);
  const senderId = sender.rows[0].id;
  const c = await pool.query<{ id: string }>(
    `INSERT INTO campaigns(tenant_id, name, status, sender_id, audience_type, audience_id)
     VALUES ($1,'Winter promo','sent',$2,'list',gen_random_uuid()) RETURNING id`, [tenantId, senderId]);
  const campaignId = c.rows[0].id;
  const imap = await pool.query<{ id: string }>(
    `INSERT INTO imap_configs (tenant_id, host, username, password_encrypted)
     VALUES ($1,'imap.x.io','u','\\x00') RETURNING id`, [tenantId]);

  // 5 sent emails, 2 of them opened.
  const emailIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const e = await pool.query<{ id: string }>(
      `INSERT INTO emails(tenant_id, sender_id, to_addr, subject, body_html, status, message_id, campaign_id, sent_at)
       VALUES ($1,$2,$3,'Promo','<p>p</p>','sent',$4,$5, now()) RETURNING id`,
      [tenantId, senderId, `r${i}@x.com`, `<m${i}@x>`, campaignId]);
    emailIds.push(e.rows[0].id);
  }
  for (const id of emailIds.slice(0, 2)) {
    await pool.query(`INSERT INTO email_events(email_id, tenant_id, type) VALUES ($1,$2,'open')`, [id, tenantId]);
  }
  return { campaignId, imapConfigId: imap.rows[0].id };
}

async function insertReply(tenantId: string, imapConfigId: string, campaignId: string, n: number, body: string) {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO inbound_emails(tenant_id, imap_config_id, imap_uid, message_id, from_addr, subject, body_text, campaign_id, received_at)
     VALUES ($1,$2,$3,$4,$5,'Re: Promo',$6,$7, now() + ($8 || ' seconds')::interval) RETURNING id`,
    [tenantId, imapConfigId, n, `<reply-${n}@x>`, `lead${n}@x.com`, body, campaignId, String(n)]);
  return r.rows[0].id;
}

describe('analyzeCampaign', () => {
  it('clusters replies, applies LLM verdict, flags hot leads, parks misfits', async () => {
    const t = await createTenant(pool);
    const { campaignId, imapConfigId } = await seedCampaign(t.id);

    const h1 = await insertReply(t.id, imapConfigId, campaignId, 1, 'TOPIC_HOURS what time do you open');
    const h2 = await insertReply(t.id, imapConfigId, campaignId, 2, 'TOPIC_HOURS are you open saturdays');
    const h3 = await insertReply(t.id, imapConfigId, campaignId, 3, 'TOPIC_HOURS holiday opening hours?');
    const p1 = await insertReply(t.id, imapConfigId, campaignId, 4, 'TOPIC_PRICE how much is it');
    const p2 = await insertReply(t.id, imapConfigId, campaignId, 5, 'TOPIC_PRICE price list please');
    const pm = await insertReply(t.id, imapConfigId, campaignId, 6, 'TOPIC_PRICE unsubscribe me');
    const hot = await insertReply(t.id, imapConfigId, campaignId, 7, 'TOPIC_BUY I want to buy 100 units, send a quote');

    const embed = async (texts: string[]) => texts.map(tx =>
      tx.includes('TOPIC_HOURS') ? vec(0) : tx.includes('TOPIC_PRICE') ? vec(1) : vec(2));

    const llm: LlmClient = {
      async chat() {
        return {
          content: JSON.stringify({
            clusters: [
              { index: 0, label: 'Asking about opening hours', intent_summary: 'When are you open', proposed_outline: 'Share trading hours', confidence: 0.9, misfit_ids: [] },
              { index: 1, label: 'Asking for pricing', intent_summary: 'Wants prices', proposed_outline: 'Send price list', confidence: 0.85, misfit_ids: [pm] },
            ],
            hot_lead_ids: [hot],
          }),
          toolCalls: [],
        };
      },
    };

    const r = await analyzeCampaign({ pool, tenantId: t.id, campaignId, embed, llm });

    expect(r.funnel).toEqual({ sent: 5, opened: 2, replied: 7, hotLeads: 1 });

    const byLabel = Object.fromEntries(r.groups.map(g => [g.label, g]));
    expect(byLabel['Asking about opening hours'].size).toBe(3);
    expect(byLabel['Asking about opening hours'].kind).toBe('standard');
    expect(byLabel['Asking for pricing'].size).toBe(2);
    expect(byLabel['Hot leads'].size).toBe(1);
    expect(byLabel['Needs your review'].size).toBe(1);

    const rows = await pool.query(
      `SELECT id, reply_group_id, group_fit, is_hot_lead, status, embedding IS NOT NULL AS embedded
       FROM inbound_emails WHERE tenant_id=$1`, [t.id]);
    const by = Object.fromEntries(rows.rows.map((x: any) => [x.id, x]));
    for (const id of [h1, h2, h3]) expect(by[id].reply_group_id).toBe(byLabel['Asking about opening hours'].id);
    for (const id of [p1, p2]) expect(by[id].reply_group_id).toBe(byLabel['Asking for pricing'].id);
    expect(by[pm].reply_group_id).toBe(byLabel['Needs your review'].id);
    expect(by[pm].group_fit).toBe('needs_review');
    expect(by[hot].reply_group_id).toBe(byLabel['Hot leads'].id);
    expect(by[hot].is_hot_lead).toBe(true);
    for (const row of rows.rows) { expect(row.embedded).toBe(true); expect(row.status).toBe('analyzed'); }

    const analysis = await latestAnalysis(pool, t.id, campaignId);
    expect(analysis?.status).toBe('ready');
    expect(analysis?.replied_count).toBe(7);
    const groups = await listReplyGroups(pool, t.id, analysis!.id);
    expect(groups).toHaveLength(4);
  });

  it('low-confidence clusters collapse into needs review; re-runs reuse embeddings', async () => {
    const t = await createTenant(pool);
    const { campaignId, imapConfigId } = await seedCampaign(t.id);
    await insertReply(t.id, imapConfigId, campaignId, 1, 'TOPIC_HOURS a');
    await insertReply(t.id, imapConfigId, campaignId, 2, 'TOPIC_HOURS b');

    let embedCalls = 0;
    const embed = async (texts: string[]) => { embedCalls += texts.length; return texts.map(() => vec(0)); };
    const llm: LlmClient = {
      async chat() {
        return {
          content: JSON.stringify({
            clusters: [{ index: 0, label: 'Mixed', intent_summary: '', proposed_outline: '', confidence: 0.2, misfit_ids: [] }],
            hot_lead_ids: [],
          }),
          toolCalls: [],
        };
      },
    };

    const r1 = await analyzeCampaign({ pool, tenantId: t.id, campaignId, embed, llm });
    expect(r1.groups.map(g => g.kind)).toEqual(['needs_review']);
    expect(r1.groups[0].size).toBe(2);
    expect(embedCalls).toBe(2);

    const r2 = await analyzeCampaign({ pool, tenantId: t.id, campaignId, embed, llm });
    expect(embedCalls).toBe(2); // embeddings cached on the rows — no re-embed
    expect(r2.analysisId).not.toBe(r1.analysisId);
  });

  it('funnel works with zero replies', async () => {
    const t = await createTenant(pool);
    const { campaignId } = await seedCampaign(t.id);
    const f = await campaignFunnel(pool, t.id, campaignId);
    expect(f).toEqual({ sent: 5, opened: 2, replied: 0, hotLeads: 0 });
  });
});
