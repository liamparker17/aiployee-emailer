// server/test/agentThreads.repo.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createContact, createSmtpConfig, createSender } from '@aiployee/core';
import { createCampaign } from '../src/repos/campaigns.js';
import { createImapConfig, seedCorrelatedReply } from './helpers/agentInbox.js';
import {
  upsertThreadsFromReplies, getThread, listThreads, applyThreadAnalysis,
  listThreadsNeedingAnalysis, getThreadContext, getReplyDispatchInfo, setThreadAfterSend,
} from '../src/repos/agentThreads.js';

const KEY = Buffer.alloc(32, 1);
const pool = makePool();
afterAll(async () => { await pool.end(); });
beforeEach(async () => { await truncateAll(pool); });

async function scaffold() {
  const t = await createTenant(pool);
  const sc = await createSmtpConfig(pool, KEY, { tenantId: t.id, name: 'l', host: 'h', port: 587, secure: false, username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true });
  const s = await createSender(pool, { tenantId: t.id, email: 'a@x.com', displayName: 'A', smtpConfigId: sc.id, isDefault: true });
  const contact = await createContact(pool, { tenantId: t.id, email: 'lead@acme.com', name: 'Lead' });
  const camp = await createCampaign(pool, { tenantId: t.id, name: 'C', senderId: s.id, subject: 'Hi', bodyHtml: '<p>Hi</p>', audienceType: 'list', audienceId: contact.id });
  const imap = await createImapConfig(pool, t.id);
  return { t, s, contact, camp, imap };
}

describe('agentThreads repo', () => {
  it('upserts one thread per (tenant,contact,campaign) and tracks the latest inbound', async () => {
    const { t, contact, camp, imap } = await scaffold();
    const r1 = await seedCorrelatedReply(pool, { tenantId: t.id, imapConfigId: imap.id, contactId: contact.id, campaignId: camp.id, fromAddr: 'lead@acme.com', receivedAt: new Date('2026-06-20T10:00:00Z') });
    const n1 = await upsertThreadsFromReplies(pool);
    expect(n1).toBe(1);

    const threads = await listThreads(pool, t.id, {});
    expect(threads).toHaveLength(1);
    expect(threads[0].stage).toBe('needs_triage');
    expect(threads[0].status).toBe('open');
    expect(threads[0].latest_inbound_email_id).toBe(r1.id);

    // A newer reply on the same conversation updates latest_inbound_email_id, not a new row.
    const r2 = await seedCorrelatedReply(pool, { tenantId: t.id, imapConfigId: imap.id, contactId: contact.id, campaignId: camp.id, fromAddr: 'lead@acme.com', receivedAt: new Date('2026-06-21T10:00:00Z') });
    await upsertThreadsFromReplies(pool);
    const after = await listThreads(pool, t.id, {});
    expect(after).toHaveLength(1);
    expect(after[0].latest_inbound_email_id).toBe(r2.id);
  });

  it('applyThreadAnalysis writes classification + stamps last_agent_analysis_at', async () => {
    const { t, contact, camp, imap } = await scaffold();
    await seedCorrelatedReply(pool, { tenantId: t.id, imapConfigId: imap.id, contactId: contact.id, campaignId: camp.id, fromAddr: 'lead@acme.com' });
    await upsertThreadsFromReplies(pool);
    const [thread] = await listThreads(pool, t.id, {});

    await applyThreadAnalysis(pool, t.id, thread.id, {
      stage: 'needs_human_reply', intent: 'pricing_request', sentiment: 'neutral', urgency: 'high',
      leadScore: 80, objectionType: null, commercialValue: 'high', nextAction: 'Reply with pricing',
      nextActionDueAt: new Date('2026-06-23T09:00:00Z'), confidence: 0.9, status: 'open',
    });

    const got = await getThread(pool, t.id, thread.id);
    expect(got?.intent).toBe('pricing_request');
    expect(got?.lead_score).toBe(80);
    expect(got?.last_agent_analysis_at).not.toBeNull();
  });

  it('listThreadsNeedingAnalysis returns threads whose latest inbound is newer than last analysis', async () => {
    const { t, contact, camp, imap } = await scaffold();
    await seedCorrelatedReply(pool, { tenantId: t.id, imapConfigId: imap.id, contactId: contact.id, campaignId: camp.id, fromAddr: 'lead@acme.com' });
    await upsertThreadsFromReplies(pool);
    const due1 = await listThreadsNeedingAnalysis(pool, 50);
    expect(due1).toHaveLength(1);

    const [thread] = await listThreads(pool, t.id, {});
    await applyThreadAnalysis(pool, t.id, thread.id, { stage: 'awaiting_customer', intent: 'interested', sentiment: 'positive', urgency: 'low', leadScore: 50, objectionType: null, commercialValue: 'medium', nextAction: null, nextActionDueAt: null, confidence: 0.7, status: 'open' });
    const due2 = await listThreadsNeedingAnalysis(pool, 50);
    expect(due2).toHaveLength(0);
  });

  it('getReplyDispatchInfo resolves the reply target + sender', async () => {
    const { t, contact, camp, imap } = await scaffold();
    await seedCorrelatedReply(pool, { tenantId: t.id, imapConfigId: imap.id, contactId: contact.id, campaignId: camp.id, fromAddr: 'lead@acme.com' });
    await upsertThreadsFromReplies(pool);
    const [thread] = await listThreads(pool, t.id, {});
    const info = await getReplyDispatchInfo(pool, t.id, thread.id);
    expect(info?.to_addr).toBe('lead@acme.com');
    expect(info?.sender_id).not.toBeNull();
  });
});
