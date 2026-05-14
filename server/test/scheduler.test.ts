import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createSmtpConfig } from '../src/repos/smtpConfigs.js';
import { createSender } from '../src/repos/senders.js';
import { insertEmail } from '../src/repos/emails.js';
import { pollDueScheduled } from '../src/send/scheduler.js';

const KEY = Buffer.alloc(32, 1);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('pollDueScheduled', () => {
  it('enqueues emails whose scheduled_for is past', async () => {
    const t = await createTenant(pool);
    const sc = await createSmtpConfig(pool, KEY, {
      tenantId: t.id, name: 'x', host: 'h', port: 25, secure: false,
      username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
    });
    const s = await createSender(pool, { tenantId: t.id, email: 'a@x.com', displayName: 'A', smtpConfigId: sc.id });
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    const eDue = await insertEmail(pool, {
      tenantId: t.id, senderId: s.id, toAddr: 'r@x.com',
      subject: 'Hi', bodyHtml: '<p>x</p>', scheduledFor: past,
    });
    await insertEmail(pool, {
      tenantId: t.id, senderId: s.id, toAddr: 'r@x.com',
      subject: 'Hi', bodyHtml: '<p>x</p>', scheduledFor: future,
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const boss = { send } as unknown as import('pg-boss');
    const n = await pollDueScheduled({ pool, boss: boss as never });
    expect(n).toBe(1);
    expect(send).toHaveBeenCalledWith('send-email', { emailId: eDue.id });
  });
});
