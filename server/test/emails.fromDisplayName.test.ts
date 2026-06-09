import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createSmtpConfig } from '../src/repos/smtpConfigs.js';
import { createSender } from '../src/repos/senders.js';
import { insertEmail } from '../src/repos/emails.js';

const KEY = Buffer.alloc(32, 1);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function seedSender(tenantId: string): Promise<string> {
  const sc = await createSmtpConfig(pool, KEY, {
    tenantId, name: 'local', host: '127.0.0.1', port: 2599, secure: false,
    username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
  });
  const s = await createSender(pool, { tenantId, email: 'a@x.com', displayName: 'A', smtpConfigId: sc.id });
  return s.id;
}

describe('insertEmail from_display_name', () => {
  it('persists from_display_name (defaults null)', async () => {
    const t = await createTenant(pool);
    const senderId = await seedSender(t.id);

    const withName = await insertEmail(pool, {
      tenantId: t.id, senderId, toAddr: 'r@x.com',
      subject: 'Hi', bodyHtml: '<p>x</p>', fromDisplayName: 'Absa Line',
    });
    expect(withName.from_display_name).toBe('Absa Line');

    const without = await insertEmail(pool, {
      tenantId: t.id, senderId, toAddr: 'r@x.com',
      subject: 'Hi', bodyHtml: '<p>x</p>',
    });
    expect(without.from_display_name).toBeNull();
  });
});
