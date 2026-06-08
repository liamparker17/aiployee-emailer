// server/test/abe.approvalEmail.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '@aiployee/core';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createSmtpConfig } from '@aiployee/core';
import { createSender } from '@aiployee/core';
import { startTestSmtp } from './helpers/smtp.js';
import { getEmail } from '@aiployee/core';
import { getActiveApprovalByPlay } from '../src/repos/agentApprovals.js';
import { hashToken } from '../src/agent/abe/approvalToken.js';
import { sendApprovalEmail, sendManagerVerifyEmail } from '../src/agent/abe/approvalEmail.js';

const KEY = Buffer.alloc(32, 1);
const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: KEY.toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
  CRON_SECRET: 'c'.repeat(24),
});

let app: Awaited<ReturnType<typeof buildApp>>;
let smtp: ReturnType<typeof startTestSmtp>;
const pool = makePool();

beforeAll(async () => { smtp = startTestSmtp(2531); app = await buildApp({ cfg }); });
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await smtp.close(); await pool.end(); });

async function seed() {
  const t = await createTenant(pool);
  const sc = await createSmtpConfig(pool, KEY, {
    tenantId: t.id, name: 'local', host: '127.0.0.1', port: 2531, secure: false,
    username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
  });
  await createSender(pool, { tenantId: t.id, email: 'abe@x.com', displayName: 'Abe', smtpConfigId: sc.id, isDefault: true });
  const g = await pool.query(
    `INSERT INTO agent_goals (tenant_id, kind, enabled, line_manager_email, line_manager_verified_at)
     VALUES ($1, 'reengage_dormant', true, 'boss@x.io', now()) RETURNING id`,
    [t.id],
  );
  const p = await pool.query(
    `INSERT INTO agent_plays (tenant_id, goal_id, status, risk_score, audience_snapshot, touches)
     VALUES ($1, $2, 'pending_approval', 60, '{"contact_ids":["c1","c2"],"size":2}',
             '[{"index":0,"subject":"Hey","body_html":"<p>hi</p>","scheduled_offset_days":0}]') RETURNING *`,
    [t.id, g.rows[0].id],
  );
  return { tenantId: t.id, play: p.rows[0] };
}

describe('sendApprovalEmail', () => {
  it('sends to the manager and creates a single-use approval row', async () => {
    const { tenantId, play } = await seed();
    const recv = smtp.lastMail();
    const res = await sendApprovalEmail({
      pool, encKey: cfg.encKey, baseUrl: cfg.publicBaseUrl,
      tenantId, play, managerEmail: 'boss@x.io',
    });
    expect(res.sent).toBe(true);

    const mail = await recv as { headers: Record<string, string> };
    expect(mail.headers.to).toContain('boss@x.io');

    const email = await getEmail(pool, tenantId, res.emailId!);
    expect(email!.status).toBe('sent');

    const approval = await getActiveApprovalByPlay(pool, play.id);
    expect(approval).not.toBeNull();
    expect(approval!.manager_email).toBe('boss@x.io');
    // token_hash equals hashToken(<token in the email>): token decodes the playId.
    expect(approval!.token_hash).toBe(hashToken(res.token!));
    expect(res.token!.startsWith(`${play.id}.`)).toBe(true);
  });

  it('is a no-op when the tenant has no default sender', async () => {
    const t = await createTenant(pool);
    const g = await pool.query(
      `INSERT INTO agent_goals (tenant_id, kind, enabled) VALUES ($1, 'reengage_dormant', true) RETURNING id`,
      [t.id],
    );
    const p = await pool.query(
      `INSERT INTO agent_plays (tenant_id, goal_id, status, risk_score, audience_snapshot, touches)
       VALUES ($1, $2, 'pending_approval', 10, '{"contact_ids":[],"size":0}', '[]') RETURNING *`,
      [t.id, g.rows[0].id],
    );
    const res = await sendApprovalEmail({
      pool, encKey: cfg.encKey, baseUrl: cfg.publicBaseUrl,
      tenantId: t.id, play: p.rows[0], managerEmail: 'boss@x.io',
    });
    expect(res.sent).toBe(false);
    expect(res.reason).toBe('no_default_sender');
    expect(await getActiveApprovalByPlay(pool, p.rows[0].id)).toBeNull();
  });
});

describe('sendManagerVerifyEmail', () => {
  it('sends a verify email to the manager', async () => {
    const { tenantId } = await seed();
    const recv = smtp.lastMail();
    const res = await sendManagerVerifyEmail({
      pool, encKey: cfg.encKey, baseUrl: cfg.publicBaseUrl,
      tenantId, managerEmail: 'boss@x.io',
    });
    expect(res.sent).toBe(true);
    const mail = await recv as { headers: Record<string, string> };
    expect(mail.headers.to).toContain('boss@x.io');
    const email = await getEmail(pool, tenantId, res.emailId!);
    expect(email!.status).toBe('sent');
  });
});
