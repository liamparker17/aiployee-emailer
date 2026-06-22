// server/test/threadAnalysis.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createContact, createSmtpConfig, createSender } from '@aiployee/core';
import { createCampaign } from '../src/repos/campaigns.js';
import { createImapConfig, seedCorrelatedReply } from './helpers/agentInbox.js';
import { upsertThreadsFromReplies, listThreads, getThread } from '../src/repos/agentThreads.js';
import { listActions } from '../src/repos/agentActions.js';
import { analyzeThread } from '../src/agent/abe/threadAnalysis.js';
import type { LlmClient } from '../src/agent/runner.js';

const KEY = Buffer.alloc(32, 1);
const pool = makePool();
afterAll(async () => { await pool.end(); });
beforeEach(async () => { await truncateAll(pool); });

function fakeLlm(json: unknown): LlmClient {
  return { chat: async () => ({ content: JSON.stringify(json), toolCalls: [] }) };
}

async function seedThread() {
  const t = await createTenant(pool);
  const sc = await createSmtpConfig(pool, KEY, { tenantId: t.id, name: 'l', host: 'h', port: 587, secure: false, username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true });
  const s = await createSender(pool, { tenantId: t.id, email: 'a@x.com', displayName: 'A', smtpConfigId: sc.id, isDefault: true });
  const contact = await createContact(pool, { tenantId: t.id, email: 'lead@acme.com', name: 'Lead' });
  const camp = await createCampaign(pool, { tenantId: t.id, name: 'C', senderId: s.id, subject: 'Hi', bodyHtml: '<p>Hi</p>', audienceType: 'list', audienceId: contact.id });
  const imap = await createImapConfig(pool, t.id);
  await seedCorrelatedReply(pool, { tenantId: t.id, imapConfigId: imap.id, contactId: contact.id, campaignId: camp.id, fromAddr: 'lead@acme.com', subject: 'Re: Hi', bodyText: 'Can you send me pricing?' });
  await upsertThreadsFromReplies(pool);
  const [thread] = await listThreads(pool, t.id, {});
  return { t, thread };
}

describe('analyzeThread', () => {
  it('classifies the thread and emits a send_reply action', async () => {
    const { t, thread } = await seedThread();
    const llm = fakeLlm({
      stage: 'needs_human_reply', intent: 'pricing_request', sentiment: 'neutral', urgency: 'medium',
      lead_score: 75, objection_type: null, commercial_value: 'high', confidence: 0.86,
      next_action: { action_type: 'send_reply', title: 'Send pricing', reason: 'Asked for a quote', risk_level: 'medium', draft_subject: 'Re: Hi', draft_body: '<p>Our pricing is...</p>', due_in_days: 1 },
    });

    const res = await analyzeThread({ pool, tenantId: t.id, threadId: thread.id, llm });
    expect(res.analyzed).toBe(true);
    expect(res.actionId).not.toBeNull();

    const got = await getThread(pool, t.id, thread.id);
    expect(got?.intent).toBe('pricing_request');
    expect(got?.lead_score).toBe(75);
    expect(got?.status).toBe('open');

    const actions = await listActions(pool, t.id, { status: 'pending' });
    expect(actions).toHaveLength(1);
    expect(actions[0].action_type).toBe('send_reply');
    expect(actions[0].draft_body).toContain('pricing');
  });

  it('derives closed status for unsubscribe intent', async () => {
    const { t, thread } = await seedThread();
    const llm = fakeLlm({
      stage: 'unsubscribed', intent: 'unsubscribe_intent', sentiment: 'negative', urgency: 'low',
      lead_score: 0, objection_type: null, commercial_value: 'low', confidence: 0.95,
      next_action: { action_type: 'escalate_thread', title: 'Suppress + close', reason: 'Asked to stop', risk_level: 'low' },
    });
    await analyzeThread({ pool, tenantId: t.id, threadId: thread.id, llm });
    const got = await getThread(pool, t.id, thread.id);
    expect(got?.stage).toBe('unsubscribed');
    expect(got?.status).toBe('closed');
  });

  it('survives unparseable model output without creating an action', async () => {
    const { t, thread } = await seedThread();
    const llm: LlmClient = { chat: async () => ({ content: 'not json at all', toolCalls: [] }) };
    const res = await analyzeThread({ pool, tenantId: t.id, threadId: thread.id, llm });
    expect(res.analyzed).toBe(false);
    expect(res.actionId).toBeNull();
    const got = await getThread(pool, t.id, thread.id);
    expect(got?.stage).toBe('needs_human_reply');
    expect(await listActions(pool, t.id, {})).toHaveLength(0);
  });
});
