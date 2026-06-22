// server/test/executeAction.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createContact, listEmails, createSmtpConfig, createSender } from '@aiployee/core';
import { createCampaign } from '../src/repos/campaigns.js';
import { createImapConfig, seedCorrelatedReply } from './helpers/agentInbox.js';
import { upsertThreadsFromReplies, listThreads, getThread } from '../src/repos/agentThreads.js';
import { createAction, getAction } from '../src/repos/agentActions.js';
import { executeApprovedAction } from '../src/agent/abe/executeAction.js';

const KEY = Buffer.alloc(32, 1);
const pool = makePool();
afterAll(async () => { await pool.end(); });
beforeEach(async () => { await truncateAll(pool); });

it('queues a reply email and advances the thread', async () => {
  const t = await createTenant(pool);
  const sc = await createSmtpConfig(pool, KEY, { tenantId: t.id, name: 'l', host: 'h', port: 587, secure: false, username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true });
  const s = await createSender(pool, { tenantId: t.id, email: 'a@x.com', displayName: 'A', smtpConfigId: sc.id, isDefault: true });
  const contact = await createContact(pool, { tenantId: t.id, email: 'lead@acme.com', name: 'Lead' });
  const camp = await createCampaign(pool, { tenantId: t.id, name: 'C', senderId: s.id, subject: 'Hi', bodyHtml: '<p>Hi</p>', audienceType: 'list', audienceId: contact.id });
  const imap = await createImapConfig(pool, t.id);
  await seedCorrelatedReply(pool, { tenantId: t.id, imapConfigId: imap.id, contactId: contact.id, campaignId: camp.id, fromAddr: 'lead@acme.com' });
  await upsertThreadsFromReplies(pool);
  const [thread] = await listThreads(pool, t.id, {});

  const action = await createAction(pool, {
    tenantId: t.id, threadId: thread.id, campaignId: camp.id, contactId: contact.id, actionType: 'send_reply',
    title: 'Send pricing', draftSubject: 'Re: Hi', draftBody: '<p>Our pricing</p>', riskLevel: 'medium', sourceRefs: {},
  });

  const { emailId } = await executeApprovedAction({ pool, tenantId: t.id, actionId: action.id });
  expect(emailId).not.toBeNull();

  const emails = await listEmails(pool, t.id, {});
  expect(emails).toHaveLength(1);
  expect(emails[0].to_addr).toBe('lead@acme.com');
  expect(emails[0].status).toBe('queued');

  expect((await getThread(pool, t.id, thread.id))?.stage).toBe('awaiting_customer');
  expect((await getAction(pool, t.id, action.id))?.status).toBe('executed');
});
