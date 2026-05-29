import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createSmtpConfig } from '../src/repos/smtpConfigs.js';
import { createSender } from '../src/repos/senders.js';
import { insertEmail, cancelScheduledEmail, getEmail, type EmailStatus } from '../src/repos/emails.js';

const KEY = Buffer.alloc(32, 1);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function mkEmail(status: EmailStatus) {
  const t = await createTenant(pool);
  const sc = await createSmtpConfig(pool, KEY, { tenantId: t.id, name: 'l', host: 'h', port: 587, secure: false, username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true });
  const s = await createSender(pool, { tenantId: t.id, email: 'a@x.com', displayName: 'A', smtpConfigId: sc.id });
  const em = await insertEmail(pool, { tenantId: t.id, senderId: s.id, toAddr: 'r@x.com', subject: 's', bodyHtml: '<p>x</p>', status });
  return { t, em };
}

describe('cancel scheduled email', () => {
  it('cancels a queued (scheduled) email', async () => {
    const { t, em } = await mkEmail('queued');
    expect(await cancelScheduledEmail(pool, t.id, em.id)).toBe(true);
    expect((await getEmail(pool, t.id, em.id))!.status).toBe('canceled');
  });

  it('refuses to cancel an already-sent email', async () => {
    const { t, em } = await mkEmail('sent');
    expect(await cancelScheduledEmail(pool, t.id, em.id)).toBe(false);
    expect((await getEmail(pool, t.id, em.id))!.status).toBe('sent');
  });
});
