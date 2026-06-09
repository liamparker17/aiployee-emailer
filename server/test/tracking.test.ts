import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createSmtpConfig } from '../src/repos/smtpConfigs.js';
import { createSender } from '../src/repos/senders.js';
import { insertEmail } from '../src/repos/emails.js';
import { recordOpen, recordClick, engagementSummary } from '../src/repos/emailEvents.js';
import { injectTracking } from '../src/send/tracking.js';

const KEY = Buffer.alloc(32, 1);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('injectTracking', () => {
  it('adds an open pixel and rewrites http links, leaving mailto/anchors alone', () => {
    const html = '<body><a href="https://example.com/x">link</a> <a href="mailto:a@b.com">m</a> <a href="#top">t</a></body>';
    const out = injectTracking(html, { emailId: 'E1', baseUrl: 'https://app.test/' });
    expect(out).toContain('https://app.test/v1/track/open/E1');
    expect(out).toContain(`https://app.test/v1/track/click/E1?u=${encodeURIComponent('https://example.com/x')}`);
    expect(out).toContain('href="mailto:a@b.com"');
    expect(out).toContain('href="#top"');
  });

  it('does not double-rewrite already-tracked links', () => {
    const tracked = '<a href="https://app.test/v1/track/click/E1?u=x">l</a>';
    const out = injectTracking(tracked, { emailId: 'E1', baseUrl: 'https://app.test' });
    expect(out.match(/v1\/track\/click/g)?.length).toBe(1);
  });
});

describe('engagement recording', () => {
  it('records opens/clicks and summarizes rates', async () => {
    const t = await createTenant(pool);
    const sc = await createSmtpConfig(pool, KEY, { tenantId: t.id, name: 'l', host: 'h', port: 587, secure: false, username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true });
    const s = await createSender(pool, { tenantId: t.id, email: 'a@x.com', displayName: 'A', smtpConfigId: sc.id });
    const em = await insertEmail(pool, { tenantId: t.id, senderId: s.id, toAddr: 'r@x.com', subject: 's', bodyHtml: '<p>x</p>', status: 'sent' });

    await recordOpen(pool, em.id);
    await recordOpen(pool, em.id);
    await recordClick(pool, em.id, 'https://example.com');

    const sum = await engagementSummary(pool, t.id);
    expect(sum.sent).toBe(1);
    expect(sum.opens).toBe(2);
    expect(sum.uniqueOpens).toBe(1);
    expect(sum.clicks).toBe(1);
    expect(sum.uniqueClicks).toBe(1);
  });
});
