import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { findDormantContacts } from '../src/repos/agentDormant.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function addContact(tenantId: string, email: string, createdDaysAgo: number) {
  const r = await pool.query(
    `INSERT INTO contacts (tenant_id, email, created_at)
     VALUES ($1, $2, now() - make_interval(days => $3)) RETURNING id`,
    [tenantId, email, createdDaysAgo],
  );
  return r.rows[0].id as string;
}
async function addSender(tenantId: string) {
  const sc = await pool.query(
    `INSERT INTO smtp_configs (tenant_id, name, host, port, secure, username, password_encrypted, from_domain)
     VALUES ($1, 'test', 'localhost', 25, false, 'u', '\\x00', 'x.io') RETURNING id`,
    [tenantId],
  );
  const r = await pool.query(
    `INSERT INTO senders (tenant_id, email, display_name, smtp_config_id) VALUES ($1, 'from@x.io', 'X', $2) RETURNING id`,
    [tenantId, sc.rows[0].id],
  );
  return r.rows[0].id as string;
}
async function addOpenedEmail(tenantId: string, senderId: string, toAddr: string, openedDaysAgo: number) {
  const e = await pool.query(
    `INSERT INTO emails (tenant_id, sender_id, to_addr, subject, body_html, status)
     VALUES ($1, $2, $3, 's', '<p>b</p>', 'sent') RETURNING id`,
    [tenantId, senderId, toAddr],
  );
  await pool.query(
    `INSERT INTO email_events (email_id, tenant_id, type, created_at)
     VALUES ($1, $2, 'open', now() - make_interval(days => $3))`,
    [e.rows[0].id, tenantId, openedDaysAgo],
  );
}

describe('findDormantContacts', () => {
  it('returns subscribed contacts with no open/click in the window, excluding recent engagers and suppressed', async () => {
    const t = await createTenant(pool);
    const sender = await addSender(t.id);

    const dormantId = await addContact(t.id, 'dormant@x.io', 100);
    await addContact(t.id, 'active@x.io', 100);
    await addOpenedEmail(t.id, sender, 'active@x.io', 5);

    await addContact(t.id, 'gone@x.io', 100);
    await pool.query(
      `INSERT INTO suppressions (tenant_id, address, reason) VALUES ($1, 'gone@x.io', 'manual')`,
      [t.id],
    );

    await addContact(t.id, 'fresh@x.io', 3);

    const rows = await findDormantContacts(pool, t.id, 60);
    expect(rows.map(r => r.email).sort()).toEqual(['dormant@x.io']);
    expect(rows[0].id).toBe(dormantId);
  });
});
