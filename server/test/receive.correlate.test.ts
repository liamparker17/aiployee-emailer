import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { correlateReply } from '../../packages/core/src/receive/correlate.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

// Minimal raw inserts so the test does not depend on factories that may not exist.
// NOTE: the real schema requires more NOT-NULL columns than the plan's first draft:
//   campaigns: sender_id, audience_type, audience_id (all NOT NULL)
//   emails:    sender_id, body_html (both NOT NULL)
// senders/smtp_configs are created here to satisfy those FKs.
async function seedCampaignSend(tenantId: string, opts: { messageId: string; toAddr: string }) {
  const cfg = await pool.query<{ id: string }>(
    `INSERT INTO smtp_configs (tenant_id, name, host, port, secure, username, password_encrypted, from_domain)
     VALUES ($1,'cfg','localhost',587,false,'u','\\x00','x.io') RETURNING id`, [tenantId]);
  const sender = await pool.query<{ id: string }>(
    `INSERT INTO senders (tenant_id, email, display_name, smtp_config_id, is_default)
     VALUES ($1,'from@x.io','X',$2,true) RETURNING id`, [tenantId, cfg.rows[0].id]);
  const senderId = sender.rows[0].id;
  const c = await pool.query<{ id: string }>(
    `INSERT INTO campaigns(tenant_id, name, status, sender_id, audience_type, audience_id)
     VALUES ($1,'C','draft',$2,'list',gen_random_uuid()) RETURNING id`, [tenantId, senderId]);
  const campaignId = c.rows[0].id;
  const contact = await pool.query<{ id: string }>(
    `INSERT INTO contacts(tenant_id, email, name) VALUES ($1,$2,'X') RETURNING id`, [tenantId, opts.toAddr]);
  const e = await pool.query<{ id: string }>(
    `INSERT INTO emails(tenant_id, sender_id, to_addr, subject, body_html, status, message_id, campaign_id, sent_at)
     VALUES ($1,$2,$3,'Hello','<p>h</p>','sent',$4,$5, now()) RETURNING id`,
    [tenantId, senderId, opts.toAddr, opts.messageId, campaignId]);
  return { campaignId, contactId: contact.rows[0].id, emailId: e.rows[0].id };
}

describe('correlateReply', () => {
  it('matches exactly via In-Reply-To → emails.message_id', async () => {
    const t = await createTenant(pool);
    const seed = await seedCampaignSend(t.id, { messageId: '<sent-1@x>', toAddr: 'lead@x.com' });
    const res = await correlateReply(pool, t.id, {
      fromAddr: 'lead@x.com', subject: 'Re: Hello', inReplyTo: '<sent-1@x>', references: null,
    });
    expect(res).toEqual({ emailId: seed.emailId, campaignId: seed.campaignId, contactId: seed.contactId });
  });

  it('falls back to contact + Re: subject within 30 days', async () => {
    const t = await createTenant(pool);
    const seed = await seedCampaignSend(t.id, { messageId: '<sent-2@x>', toAddr: 'lead@x.com' });
    const res = await correlateReply(pool, t.id, {
      fromAddr: 'lead@x.com', subject: 'RE: something else', inReplyTo: null, references: null,
    });
    expect(res.contactId).toBe(seed.contactId);
    expect(res.campaignId).toBe(seed.campaignId);
    expect(res.emailId).toBeNull();
  });

  it('returns all-null when nothing matches', async () => {
    const t = await createTenant(pool);
    const res = await correlateReply(pool, t.id, {
      fromAddr: 'stranger@x.com', subject: 'cold inbound', inReplyTo: null, references: null,
    });
    expect(res).toEqual({ emailId: null, campaignId: null, contactId: null });
  });
});
