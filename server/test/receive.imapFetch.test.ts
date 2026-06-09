import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createImapConfig } from '../../packages/core/src/repos/imapConfigs.js';
import { getSyncState } from '../../packages/core/src/repos/imapSyncState.js';
import { listInboundByCampaign } from '../../packages/core/src/repos/inboundEmails.js';
import { syncMailbox } from '../../packages/core/src/receive/imapFetch.js';
import type { ImapSession, RawMessage } from '../../packages/core/src/receive/imapFetch.js';

const pool = makePool();
const encKey = Buffer.alloc(32, 7);
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

function rawReply(uid: number, messageId: string, inReplyTo: string): RawMessage {
  const src = Buffer.from([
    'From: Jane Lead <lead@x.com>', 'To: box@x.com', 'Subject: Re: Hello',
    `Message-ID: <${messageId}>`, `In-Reply-To: <${inReplyTo}>`,
    'Date: Tue, 09 Jun 2026 10:00:00 +0000', 'Content-Type: text/plain', '',
    'opening hours?', '',
  ].join('\r\n'), 'utf8');
  return { uid, source: src };
}

// Seed a sent campaign email. The real schema requires more NOT-NULL columns
// than the plan's first draft (mirrors receive.correlate.test.ts):
//   campaigns: sender_id, audience_type, audience_id (all NOT NULL)
//   emails:    sender_id, body_html (both NOT NULL)
//   senders/smtp_configs created to satisfy those FKs.
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

describe('syncMailbox', () => {
  it('fetches new messages, correlates, inserts, and advances the cursor', async () => {
    const t = await createTenant(pool);
    const cfg = await createImapConfig(pool, encKey, { tenantId: t.id, senderId: null, host: 'h', port: 993, secure: true, username: 'u', password: 'p', enabled: true });

    // Seed a sent campaign email so correlation finds a campaign.
    const seed = await seedCampaignSend(t.id, { messageId: '<sent-1@x>', toAddr: 'lead@x.com' });

    const fakeConnect = async (): Promise<ImapSession> => ({
      uidValidity: 555,
      async *fetchSince(uid: number): AsyncIterable<RawMessage> {
        const all = [rawReply(10, 'reply-1@x', 'sent-1@x')];
        for (const m of all) if (m.uid > uid) yield m;
      },
      async close() { /* noop */ },
    });

    const res = await syncMailbox({ pool, encKey, configId: cfg.id, connect: fakeConnect });
    expect(res.fetched).toBe(1);
    expect(res.inserted).toBe(1);

    const rows = await listInboundByCampaign(pool, t.id, seed.campaignId);
    expect(rows.length).toBe(1);
    expect(rows[0].from_addr).toBe('lead@x.com');
    expect(rows[0].campaign_id).toBe(seed.campaignId);

    const state = await getSyncState(pool, cfg.id, 'INBOX');
    expect(state?.last_seen_uid).toBe('10');
    expect(state?.uid_validity).toBe('555');
  });

  it('is idempotent on a second run with the same mailbox', async () => {
    const t = await createTenant(pool);
    const cfg = await createImapConfig(pool, encKey, { tenantId: t.id, senderId: null, host: 'h', port: 993, secure: true, username: 'u', password: 'p', enabled: true });
    const connect = async (): Promise<ImapSession> => ({
      uidValidity: 1,
      async *fetchSince(uid: number) { if (10 > uid) yield rawReply(10, 'only@x', 'none@x'); },
      async close() {},
    });
    const first = await syncMailbox({ pool, encKey, configId: cfg.id, connect });
    const second = await syncMailbox({ pool, encKey, configId: cfg.id, connect });
    expect(first.inserted).toBe(1);
    expect(second.fetched).toBe(0); // cursor advanced past uid 10
  });
});
