import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createSmtpConfig } from '../src/repos/smtpConfigs.js';
import { createSender } from '../src/repos/senders.js';
import { listCalls } from '../src/repos/callAnalytics.js';
import { backfillCallsFromEmails } from '../src/agent/abe/backfillCalls.js';

const KEY = Buffer.alloc(32, 1);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

// Stub LLM whose output parses for lineTagger ({"tags":[...]}). With no
// line-report config seeded, tagNewCalls returns 0 anyway — but the stub must
// still be shaped so the tagging step never throws.
const stub = { chat: async () => ({ content: JSON.stringify({ tags: [] }) }) };

async function seedSender(tenantId: string): Promise<string> {
  const sc = await createSmtpConfig(pool, KEY, {
    tenantId, name: 'local', host: '127.0.0.1', port: 2599, secure: false,
    username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
  });
  const s = await createSender(pool, { tenantId, email: 'a@x.com', displayName: 'A', smtpConfigId: sc.id });
  return s.id;
}

async function seedSentEmail(tenantId: string, senderId: string, subject: string, bodyText: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO emails(tenant_id, sender_id, to_addr, subject, body_html, body_text, status)
     VALUES ($1,$2,'r@x.com',$3,'<p>x</p>',$4,'sent') RETURNING id`,
    [tenantId, senderId, subject, bodyText]);
  return r.rows[0].id;
}

describe('backfillCallsFromEmails', () => {
  it('imports sent emails as calls and tags them; re-run imports nothing new', async () => {
    const t = await createTenant(pool);
    const senderId = await seedSender(t.id);
    await seedSentEmail(t.id, senderId, 'Call', 'caller asking about their claim');
    await seedSentEmail(t.id, senderId, 'Call', 'general enquiry about hours');

    const r = await backfillCallsFromEmails({ pool, tenantId: t.id, llm: stub as never, model: 'gpt-4o' });
    expect(r.imported).toBe(2);
    expect((await listCalls(pool, t.id, {})).total).toBe(2);

    const r2 = await backfillCallsFromEmails({ pool, tenantId: t.id, llm: stub as never, model: 'gpt-4o' });
    expect(r2.imported).toBe(0); // idempotent
    expect((await listCalls(pool, t.id, {})).total).toBe(2);
  });
});
