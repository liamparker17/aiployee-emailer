import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createSmtpConfig } from '../src/repos/smtpConfigs.js';
import { createSender } from '../src/repos/senders.js';
import { makeLineChatProvider } from '../src/agent/abe/lineChatTools.js';

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

describe('search_emails chat tool', () => {
  it('search_emails counts sent emails matching the text', async () => {
    const t = await createTenant(pool);
    const senderId = await seedSender(t.id);
    await pool.query(
      `INSERT INTO emails(tenant_id, sender_id, to_addr, subject, body_html, body_text, status)
       VALUES ($1,$2,'r@x.com','Claim','<p>x</p>','wants to lodge a claim','sent')`,
      [t.id, senderId]);

    const p = makeLineChatProvider({ pool, tenantId: t.id });
    const out = JSON.parse(await p.callTool('search_emails', { text: 'claim', windowDays: 30 }));
    expect(out.count).toBe(1);
    expect((await p.listTools()).map((x: { name: string }) => x.name)).toContain('search_emails');
  });
});
