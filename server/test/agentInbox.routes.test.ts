import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '@aiployee/core';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant, createUser } from './helpers/factories.js';
import { createSmtpConfig, createSender, createContact, listEmails } from '@aiployee/core';
import { createCampaign } from '../src/repos/campaigns.js';
import { csrfFor, login } from './helpers/auth.js';
import { createImapConfig, seedCorrelatedReply } from './helpers/agentInbox.js';
import { upsertThreadsFromReplies, listThreads } from '../src/repos/agentThreads.js';
import { createAction } from '../src/repos/agentActions.js';

const KEY = Buffer.alloc(32, 1);
const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32), EMAILER_ENC_KEY: KEY.toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000', CRON_SECRET: 'c'.repeat(24),
});
const pool = makePool();
let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => { app = await buildApp({ cfg }); });
afterAll(async () => { await app.close(); await pool.end(); });
beforeEach(async () => { await truncateAll(pool); });

async function scaffold() {
  const t = await createTenant(pool);
  const admin = await createUser(pool, { tenantId: t.id, email: 'admin@x.com', password: 'pw123456', role: 'tenant_admin' });
  const sc = await createSmtpConfig(pool, KEY, { tenantId: t.id, name: 'l', host: 'h', port: 587, secure: false, username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true });
  const s = await createSender(pool, { tenantId: t.id, email: 'a@x.com', displayName: 'A', smtpConfigId: sc.id, isDefault: true });
  const contact = await createContact(pool, { tenantId: t.id, email: 'lead@acme.com', name: 'Lead' });
  const camp = await createCampaign(pool, { tenantId: t.id, name: 'C', senderId: s.id, subject: 'Hi', bodyHtml: '<p>Hi</p>', audienceType: 'list', audienceId: contact.id });
  const imap = await createImapConfig(pool, t.id);
  await seedCorrelatedReply(pool, { tenantId: t.id, imapConfigId: imap.id, contactId: contact.id, campaignId: camp.id, fromAddr: 'lead@acme.com' });
  await upsertThreadsFromReplies(pool);
  const [thread] = await listThreads(pool, t.id, {});
  const csrf = await csrfFor(app);
  const headers = await login(app, { email: 'admin@x.com', password: 'pw123456' }, csrf);
  return { t, admin, camp, contact, thread, headers, csrf };
}

describe('agent inbox API', () => {
  it('lists threads for the tenant', async () => {
    const { headers } = await scaffold();
    const res = await app.inject({ method: 'GET', url: '/api/agent/inbox/threads', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().threads).toHaveLength(1);
  });

  it('approving a send_reply action queues the email and executes the action', async () => {
    const { t, thread, camp, contact, headers } = await scaffold();
    const action = await createAction(pool, {
      tenantId: t.id, threadId: thread.id, campaignId: camp.id, contactId: contact.id, actionType: 'send_reply',
      title: 'Send pricing', draftSubject: 'Re: Hi', draftBody: '<p>pricing</p>', riskLevel: 'medium', sourceRefs: {},
    });
    const res = await app.inject({
      method: 'POST', url: `/api/agent/inbox/actions/${action.id}/approve`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().emailId).toBeTruthy();
    expect(res.json().action.status).toBe('executed');
    expect(await listEmails(pool, t.id, {})).toHaveLength(1);
  });

  it('blocks a non-admin from approving', async () => {
    const { t, thread, camp, contact } = await scaffold();
    await createUser(pool, { tenantId: t.id, email: 'user@x.com', password: 'pw123456', role: 'tenant_user' });
    const action = await createAction(pool, { tenantId: t.id, threadId: thread.id, campaignId: camp.id, contactId: contact.id, actionType: 'send_reply', title: 'x', draftSubject: 'Re', draftBody: '<p>x</p>', sourceRefs: {} });
    const csrf = await csrfFor(app);
    const userHeaders = await login(app, { email: 'user@x.com', password: 'pw123456' }, csrf);
    const res = await app.inject({ method: 'POST', url: `/api/agent/inbox/actions/${action.id}/approve`, headers: userHeaders });
    expect(res.statusCode).toBe(403);
  });
});
