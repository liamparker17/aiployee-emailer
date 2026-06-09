import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createImapConfig } from '../../packages/core/src/repos/imapConfigs.js';
import { insertInboundEmail, listInboundByCampaign } from '../../packages/core/src/repos/inboundEmails.js';

const pool = makePool();
const encKey = Buffer.alloc(32, 7);
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('inboundEmails repo', () => {
  it('inserts and is idempotent on (tenant_id, message_id)', async () => {
    const t = await createTenant(pool);
    const cfg = await createImapConfig(pool, encKey, { tenantId: t.id, senderId: null, host: 'h', port: 993, secure: true, username: 'u', password: 'p', enabled: true });
    const base = {
      tenantId: t.id, imapConfigId: cfg.id, imapUid: 1, messageId: '<m1@x>',
      inReplyTo: null, references: null, fromAddr: 'a@x.com', fromName: 'A',
      toAddr: 'box@x.com', subject: 'Re: hi', bodyText: 'hello', bodyHtml: null,
      receivedAt: new Date('2026-06-09T10:00:00Z'),
      emailId: null, campaignId: null, contactId: null,
    };
    const first = await insertInboundEmail(pool, base);
    expect(first.inserted).toBe(true);
    const dup = await insertInboundEmail(pool, { ...base, imapUid: 2 });
    expect(dup.inserted).toBe(false); // same message_id → no-op
  });
});
