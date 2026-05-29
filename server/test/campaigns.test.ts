import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createSmtpConfig } from '../src/repos/smtpConfigs.js';
import { createSender } from '../src/repos/senders.js';
import { createContact } from '../src/repos/contacts.js';
import { createList, addMembers } from '../src/repos/contactLists.js';
import { createCampaign } from '../src/repos/campaigns.js';
import { addSuppression } from '../src/repos/suppressions.js';
import { sendCampaign } from '../src/marketing/campaignSend.js';
import { signUnsubToken, verifyUnsubToken } from '../src/marketing/unsubscribe.js';
import { listEmails } from '../src/repos/emails.js';

const KEY = Buffer.alloc(32, 1);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('unsubscribe token', () => {
  it('round-trips and rejects tampering', () => {
    const tok = signUnsubToken('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', KEY);
    expect(verifyUnsubToken(tok, KEY)).toEqual({ tenantId: '11111111-1111-1111-1111-111111111111', contactId: '22222222-2222-2222-2222-222222222222' });
    expect(verifyUnsubToken(tok + 'x', KEY)).toBeNull();
    expect(verifyUnsubToken('a.b.c', KEY)).toBeNull();
  });
});

describe('campaign send', () => {
  it('queues subscribed recipients, skips suppressed, tags campaign + unsub link', async () => {
    const t = await createTenant(pool);
    const sc = await createSmtpConfig(pool, KEY, { tenantId: t.id, name: 'l', host: 'h', port: 587, secure: false, username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true });
    const s = await createSender(pool, { tenantId: t.id, email: 'a@x.com', displayName: 'A', smtpConfigId: sc.id });
    const c1 = await createContact(pool, { tenantId: t.id, email: 'one@x.com', name: 'One' });
    const c2 = await createContact(pool, { tenantId: t.id, email: 'two@x.com' });
    await addSuppression(pool, { tenantId: t.id, address: 'two@x.com', reason: 'manual' }); // c2 suppressed
    const list = await createList(pool, t.id, 'L');
    await addMembers(pool, t.id, list.id, [c1.id, c2.id]);
    const camp = await createCampaign(pool, { tenantId: t.id, name: 'C', senderId: s.id, subject: 'Hi {{name}}', bodyHtml: '<p>Hello {{name}}</p>', audienceType: 'list', audienceId: list.id });

    const r = await sendCampaign({ pool, encKey: KEY, baseUrl: 'https://app.test', tenantId: t.id, campaignId: camp.id });
    expect(r.queued).toBe(1);
    expect(r.skipped).toBe(1);

    const emails = await listEmails(pool, t.id, {});
    expect(emails).toHaveLength(1);
    expect(emails[0].to_addr).toBe('one@x.com');
    expect(emails[0].subject).toBe('Hi One');
    expect(emails[0].body_html).toContain('/v1/unsubscribe/');
    expect(emails[0].status).toBe('queued');
  });
});
