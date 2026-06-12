import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, encrypt } from '@aiployee/core';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { latestAnalysis, listReplyGroups } from '../src/repos/campaignAnalyses.js';
import type { LlmClient } from '../src/agent/runner.js';

const encKeyB64 = Buffer.alloc(32, 1).toString('base64');
const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: encKeyB64,
  PUBLIC_BASE_URL: 'http://localhost:3000',
  CRON_SECRET: 'c'.repeat(24),
});
const cronHeaders = { 'x-cron-secret': 'c'.repeat(24) };

// Same-vector embeddings: every reply lands in one cluster; the stub verdict steers the rest.
const vec = (i: number): number[] => { const v = new Array(1536).fill(0); v[i] = 1; return v; };
let hotLeadIds: string[] = [];
const stubLlm: LlmClient = {
  async chat() {
    return {
      content: JSON.stringify({
        clusters: [{ index: 0, label: 'Interested', intent_summary: 'Wants info', proposed_outline: 'Reply warmly', confidence: 0.9, misfit_ids: [] }],
        hot_lead_ids: hotLeadIds,
      }),
      toolCalls: [],
    };
  },
};

let app: Awaited<ReturnType<typeof buildApp>>;
const pool = makePool();

beforeAll(async () => {
  app = await buildApp({
    cfg,
    agentLlmFactory: () => stubLlm,
    agentEmbedFactory: () => async (texts: string[]) => texts.map(() => vec(0)),
  });
});
beforeEach(async () => { await truncateAll(pool); hotLeadIds = []; });
afterAll(async () => { await app.close(); await pool.end(); });

async function seedCampaign(tenantId: string) {
  const smtp = await pool.query<{ id: string }>(
    `INSERT INTO smtp_configs (tenant_id, name, host, port, secure, username, password_encrypted, from_domain)
     VALUES ($1,'cfg','localhost',587,false,'u','\\x00','x.io') RETURNING id`, [tenantId]);
  const sender = await pool.query<{ id: string }>(
    `INSERT INTO senders (tenant_id, email, display_name, smtp_config_id, is_default)
     VALUES ($1,'from@x.io','X',$2,true) RETURNING id`, [tenantId, smtp.rows[0].id]);
  const c = await pool.query<{ id: string }>(
    `INSERT INTO campaigns(tenant_id, name, status, sender_id, audience_type, audience_id)
     VALUES ($1,'Winter promo','sent',$2,'list',gen_random_uuid()) RETURNING id`, [tenantId, sender.rows[0].id]);
  const imap = await pool.query<{ id: string }>(
    `INSERT INTO imap_configs (tenant_id, host, username, password_encrypted)
     VALUES ($1,'imap.x.io','u','\\x00') RETURNING id`, [tenantId]);
  return { campaignId: c.rows[0].id, imapConfigId: imap.rows[0].id };
}

// Replies land in the PAST so a completed run (run_at = now()) is newer than every reply.
async function insertReply(tenantId: string, imapConfigId: string, campaignId: string, n: number, body: string) {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO inbound_emails(tenant_id, imap_config_id, imap_uid, message_id, from_addr, subject, body_text, campaign_id, received_at)
     VALUES ($1,$2,$3,$4,$5,'Re: Promo',$6,$7, now() - ($8 || ' seconds')::interval) RETURNING id`,
    [tenantId, imapConfigId, n, `<reply-${n}@x>`, `lead${n}@x.com`, body, campaignId, String(60 - n)]);
  return r.rows[0].id;
}

async function setOpenAIKey(tenantId: string) {
  await pool.query(
    `INSERT INTO agent_configs (tenant_id, enabled, model, openai_key_encrypted) VALUES ($1, true, 'gpt-4.1', $2)`,
    [tenantId, encrypt('sk-test', Buffer.from(encKeyB64, 'base64'))],
  );
}

describe('POST /v1/cron/analyze-replies', () => {
  it('rejects without the cron secret', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/cron/analyze-replies' });
    expect(res.statusCode).toBe(401);
  });

  it('analyses campaigns with new replies, flags hot leads, then goes quiet until new replies arrive', async () => {
    const t = await createTenant(pool);
    await setOpenAIKey(t.id);
    const { campaignId, imapConfigId } = await seedCampaign(t.id);
    await insertReply(t.id, imapConfigId, campaignId, 1, 'tell me more');
    await insertReply(t.id, imapConfigId, campaignId, 2, 'sounds interesting');
    hotLeadIds = [await insertReply(t.id, imapConfigId, campaignId, 3, 'I want to buy now')];

    const res = await app.inject({ method: 'POST', url: '/v1/cron/analyze-replies', headers: cronHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, due: 1, analyzed: 1, skipped: [] });

    const analysis = await latestAnalysis(pool, t.id, campaignId);
    expect(analysis?.status).toBe('ready');
    const groups = await listReplyGroups(pool, t.id, analysis!.id);
    const byLabel = Object.fromEntries(groups.map(g => [g.label, g]));
    expect(byLabel['Interested'].size).toBe(2);
    expect(byLabel['Hot leads'].size).toBe(1);
    const hot = await pool.query(`SELECT count(*)::int AS n FROM inbound_emails WHERE tenant_id=$1 AND is_hot_lead`, [t.id]);
    expect(hot.rows[0].n).toBe(1);

    // No new replies since the run → nothing due on the next tick.
    const res2 = await app.inject({ method: 'POST', url: '/v1/cron/analyze-replies', headers: cronHeaders });
    expect(res2.json()).toMatchObject({ ok: true, due: 0, analyzed: 0 });

    // A fresh reply re-arms the campaign.
    await pool.query(
      `INSERT INTO inbound_emails(tenant_id, imap_config_id, imap_uid, message_id, from_addr, subject, body_text, campaign_id, received_at)
       VALUES ($1,$2,99,'<reply-99@x>','late@x.com','Re: Promo','me too please',$3, now() + interval '1 second')`,
      [t.id, imapConfigId, campaignId]);
    const res3 = await app.inject({ method: 'POST', url: '/v1/cron/analyze-replies', headers: cronHeaders });
    expect(res3.json()).toMatchObject({ ok: true, due: 1, analyzed: 1 });
  });

  it('skips tenants without an OpenAI key (no factory-less crash, no analysis row left running)', async () => {
    const bare = await buildApp({ cfg }); // no stub factories → key requirement is enforced
    try {
      const t = await createTenant(pool);
      const { campaignId, imapConfigId } = await seedCampaign(t.id);
      await insertReply(t.id, imapConfigId, campaignId, 1, 'hello?');

      const res = await bare.inject({ method: 'POST', url: '/v1/cron/analyze-replies', headers: cronHeaders });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        ok: true, due: 1, analyzed: 0,
        skipped: [{ campaignId, reason: 'no_openai_key' }],
      });
      expect(await latestAnalysis(pool, t.id, campaignId)).toBeNull();
    } finally {
      await bare.close();
    }
  });
});
