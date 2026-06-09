import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createSmtpConfig } from '@aiployee/core';
import { createSender } from '@aiployee/core';
import { insertEmail, claimForSend, markSent, markFailed, getEmail } from '@aiployee/core';

const KEY = Buffer.alloc(32, 1);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function setup() {
  const t = await createTenant(pool);
  const sc = await createSmtpConfig(pool, KEY, {
    tenantId: t.id, name: 'SES', host: 'h', port: 25, secure: false,
    username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
  });
  const s = await createSender(pool, {
    tenantId: t.id, email: 'a@x.com', displayName: 'A', smtpConfigId: sc.id,
  });
  return { t, sc, s };
}

describe('emails repo', () => {
  it('inserts queued email and transitions to sent', async () => {
    const { t, s } = await setup();
    const e = await insertEmail(pool, {
      tenantId: t.id, senderId: s.id, toAddr: 'r@x.com',
      subject: 'Hi', bodyHtml: '<p>x</p>',
    });
    expect(e.status).toBe('queued');
    const claimed = await claimForSend(pool, e.id);
    expect(claimed!.status).toBe('sending');
    await markSent(pool, e.id, 'msg-1');
    const after = await getEmail(pool, t.id, e.id);
    expect(after!.status).toBe('sent');
    expect(after!.message_id).toBe('msg-1');
  });

  it('markFailed records error', async () => {
    const { t, s } = await setup();
    const e = await insertEmail(pool, {
      tenantId: t.id, senderId: s.id, toAddr: 'r@x.com',
      subject: 'Hi', bodyHtml: '<p>x</p>',
    });
    await markFailed(pool, e.id, 'connection refused');
    const after = await getEmail(pool, t.id, e.id);
    expect(after!.status).toBe('failed');
    expect(after!.error).toBe('connection refused');
  });
});
