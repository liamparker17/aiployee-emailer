// server/test/cron.analyzeThreads.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '@aiployee/core';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createContact, createSmtpConfig, createSender } from '@aiployee/core';
import { createCampaign } from '../src/repos/campaigns.js';
import { createImapConfig, seedCorrelatedReply } from './helpers/agentInbox.js';
import { listThreads } from '../src/repos/agentThreads.js';
import { listActions } from '../src/repos/agentActions.js';
import type { LlmClient } from '../src/agent/runner.js';

const KEY = Buffer.alloc(32, 1);
const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32), EMAILER_ENC_KEY: KEY.toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000', CRON_SECRET: 'c'.repeat(24),
});
const pool = makePool();

// Inject a deterministic LLM via buildApp so the cron does not need a real OpenAI key.
// This mirrors the pattern in cron.analyzeReplies.test.ts (factory passed at build time,
// not post-build assignment as the brief suggests — buildApp accepts it as a dep option).
const stubLlm: LlmClient = {
  chat: async () => ({ content: JSON.stringify({
    stage: 'needs_human_reply', intent: 'pricing_request', sentiment: 'neutral', urgency: 'medium',
    lead_score: 60, objection_type: null, commercial_value: 'medium', confidence: 0.8,
    next_action: { action_type: 'send_reply', title: 'Send pricing', reason: 'asked', risk_level: 'medium', draft_subject: 'Re: Hi', draft_body: '<p>pricing</p>', due_in_days: 1 },
  }), toolCalls: [] }),
};

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp({ cfg, agentLlmFactory: () => stubLlm });
});
afterAll(async () => { await app.close(); await pool.end(); });
beforeEach(async () => { await truncateAll(pool); });

describe('/v1/cron/analyze-threads', () => {
  it('upserts threads and analyzes them, creating actions', async () => {
    const t = await createTenant(pool);
    const sc = await createSmtpConfig(pool, KEY, { tenantId: t.id, name: 'l', host: 'h', port: 587, secure: false, username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true });
    const s = await createSender(pool, { tenantId: t.id, email: 'a@x.com', displayName: 'A', smtpConfigId: sc.id, isDefault: true });
    const contact = await createContact(pool, { tenantId: t.id, email: 'lead@acme.com', name: 'Lead' });
    const camp = await createCampaign(pool, { tenantId: t.id, name: 'C', senderId: s.id, subject: 'Hi', bodyHtml: '<p>Hi</p>', audienceType: 'list', audienceId: contact.id });
    const imap = await createImapConfig(pool, t.id);
    await seedCorrelatedReply(pool, { tenantId: t.id, imapConfigId: imap.id, contactId: contact.id, campaignId: camp.id, fromAddr: 'lead@acme.com', bodyText: 'pricing please' });

    const res = await app.inject({ method: 'POST', url: '/v1/cron/analyze-threads', headers: { authorization: 'Bearer ' + 'c'.repeat(24) } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.upserted).toBe(1);
    expect(body.analyzed).toBe(1);

    expect(await listThreads(pool, t.id, {})).toHaveLength(1);
    expect(await listActions(pool, t.id, { status: 'pending' })).toHaveLength(1);
  });

  it('rejects without the cron secret', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/cron/analyze-threads' });
    expect(res.statusCode).toBe(401);
  });
});
