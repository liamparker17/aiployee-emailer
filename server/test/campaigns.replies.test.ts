import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createSmtpConfig } from '@aiployee/core';
import { createSender } from '@aiployee/core';
import { createImapConfig } from '../../packages/core/src/repos/imapConfigs.js';
import { insertInboundEmail } from '../../packages/core/src/repos/inboundEmails.js';
import { createCampaign, campaignStats, campaignReplies } from '../src/repos/campaigns.js';
import { createAnalysis, insertReplyGroup, assignRepliesToGroup, setHotLeads } from '../src/repos/campaignAnalyses.js';

const pool = makePool();
const KEY = Buffer.alloc(32, 7);
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function seedCampaign(tenantId: string) {
  const sc = await createSmtpConfig(pool, KEY, { tenantId, name: 'l', host: 'h', port: 587, secure: false, username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true });
  const s = await createSender(pool, { tenantId, email: 'a@x.com', displayName: 'A', smtpConfigId: sc.id });
  return createCampaign(pool, { tenantId, name: 'C', senderId: s.id, subject: 'Hi', bodyHtml: '<p>Hello</p>', audienceType: 'list', audienceId: '00000000-0000-0000-0000-000000000000' });
}

describe('campaign replies analytics', () => {
  it('counts replies, repliers and hot leads; lists replies hot-first then newest, with analysis fields', async () => {
    const t = await createTenant(pool);
    const camp = await seedCampaign(t.id);
    const cfg = await createImapConfig(pool, KEY, { tenantId: t.id, senderId: null, host: 'h', port: 993, secure: true, username: 'u', password: 'p', enabled: true });

    const base = {
      tenantId: t.id, imapConfigId: cfg.id, inReplyTo: null, references: null,
      fromName: null, toAddr: 'box@x.com', bodyHtml: null, emailId: null, contactId: null,
    };
    const r1 = await insertInboundEmail(pool, { ...base, imapUid: 1, messageId: '<r1@x>', fromAddr: 'one@x.com', fromName: 'One',
      subject: 'Re: Hi', bodyText: 'Sounds great, send details. '.repeat(20), receivedAt: new Date('2026-06-10T08:00:00Z'), campaignId: camp.id });
    await insertInboundEmail(pool, { ...base, imapUid: 2, messageId: '<r2@x>', fromAddr: 'one@x.com',
      subject: 'Re: Hi again', bodyText: 'Following up.', receivedAt: new Date('2026-06-10T09:00:00Z'), campaignId: camp.id });
    await insertInboundEmail(pool, { ...base, imapUid: 3, messageId: '<r3@x>', fromAddr: 'two@x.com',
      subject: 'Re: Hi', bodyText: 'Not interested.', receivedAt: new Date('2026-06-10T10:00:00Z'), campaignId: camp.id });
    // an uncorrelated inbound (no campaign) must not count
    await insertInboundEmail(pool, { ...base, imapUid: 4, messageId: '<r4@x>', fromAddr: 'x@x.com',
      subject: 'hello', bodyText: 'spam', receivedAt: new Date('2026-06-10T11:00:00Z'), campaignId: null });

    // Abe's analysis: r1 (the oldest) is a hot lead classified 'Wants details'
    const analysis = await createAnalysis(pool, t.id, camp.id);
    const group = await insertReplyGroup(pool, { tenantId: t.id, analysisId: analysis.id, label: 'Wants details',
      size: 1, proposedOutline: 'Send the brochure and offer a 15-min call', kind: 'standard' });
    await assignRepliesToGroup(pool, t.id, group.id, [r1.id!], 'fit');
    await setHotLeads(pool, t.id, [r1.id!]);

    const stats = await campaignStats(pool, t.id, camp.id);
    expect(stats.replies).toBe(3);
    expect(stats.repliers).toBe(2);
    expect(stats.hot_leads).toBe(1);

    const replies = await campaignReplies(pool, t.id, camp.id);
    expect(replies).toHaveLength(3);
    // hot lead floats to the top despite being the oldest, carrying its classification
    expect(replies[0].id).toBe(r1.id);
    expect(replies[0].is_hot_lead).toBe(true);
    expect(replies[0].group_label).toBe('Wants details');
    expect(replies[0].draft_status).toBe('none');
    expect(replies[0].proposed_outline).toBe('Send the brochure and offer a 15-min call');
    expect((replies[0].snippet ?? '').length).toBeLessThanOrEqual(240);
    // the rest stay newest-first with no analysis fields
    expect(replies[1].from_addr).toBe('two@x.com');
    expect(replies[1].is_hot_lead).toBe(false);
    expect(replies[1].group_label).toBeNull();
  });

  it('reports zero replies for a campaign with none', async () => {
    const t = await createTenant(pool);
    const camp = await seedCampaign(t.id);
    const stats = await campaignStats(pool, t.id, camp.id);
    expect(stats.replies).toBe(0);
    expect(stats.repliers).toBe(0);
    expect(stats.hot_leads).toBe(0);
    expect(await campaignReplies(pool, t.id, camp.id)).toEqual([]);
  });
});
