import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { startTestSmtp } from './helpers/smtp.js';
import { createTenant } from './helpers/factories.js';
import { createSmtpConfig } from '../src/repos/smtpConfigs.js';
import { createSender } from '../src/repos/senders.js';
import { insertEmail, getEmail } from '../src/repos/emails.js';
import { handleSendJob } from '../src/send/worker.js';

const KEY = Buffer.alloc(32, 1);
const pool = makePool();
let smtp: ReturnType<typeof startTestSmtp>;

beforeAll(() => { smtp = startTestSmtp(2526); });
afterAll(async () => { await smtp.close(); await pool.end(); });
beforeEach(async () => { await truncateAll(pool); });

describe('handleSendJob', () => {
  it('delivers a queued email through SMTP and marks it sent', async () => {
    const t = await createTenant(pool);
    const sc = await createSmtpConfig(pool, KEY, {
      tenantId: t.id, name: 'local', host: '127.0.0.1', port: 2526, secure: false,
      username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
    });
    const s = await createSender(pool, { tenantId: t.id, email: 'a@x.com', displayName: 'A', smtpConfigId: sc.id });
    const e = await insertEmail(pool, {
      tenantId: t.id, senderId: s.id, toAddr: 'r@x.com',
      subject: 'Hi', bodyHtml: '<p>hi</p>',
    });
    const recv = smtp.lastMail();
    await handleSendJob({ pool, encKey: KEY, emailId: e.id });
    const mail = await recv as { headers: Record<string, string> };
    expect(mail.headers.subject).toContain('Hi');
    const after = await getEmail(pool, t.id, e.id);
    expect(after!.status).toBe('sent');
    expect(after!.message_id).toBeTruthy();
  });
});
