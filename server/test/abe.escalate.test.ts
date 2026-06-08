// server/test/abe.escalate.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '@aiployee/core';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createSmtpConfig } from '@aiployee/core';
import { createSender } from '@aiployee/core';
import { startTestSmtp } from './helpers/smtp.js';
import { getActiveApprovalByPlay } from '../src/repos/agentApprovals.js';
import { getGoal } from '../src/repos/agentGoals.js';
import type { GoalRow } from '../src/repos/agentGoals.js';
import type { PlayRow } from '../src/repos/agentPlays.js';
import { escalatePlay } from '../src/agent/abe/escalate.js';

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

beforeAll(async () => { smtp = startTestSmtp(2533); app = await buildApp({ cfg }); });
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await smtp.close(); await pool.end(); });

async function seed(opts: { verified: boolean; managerEmail: string | null }) {
  const t = await createTenant(pool);
  const sc = await createSmtpConfig(pool, KEY, {
    tenantId: t.id, name: 'local', host: '127.0.0.1', port: 2533, secure: false,
    username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
  });
  await createSender(pool, { tenantId: t.id, email: 'abe@x.com', displayName: 'Abe', smtpConfigId: sc.id, isDefault: true });
  const g = await pool.query<GoalRow>(
    `INSERT INTO agent_goals (tenant_id, kind, enabled, line_manager_email, line_manager_verified_at)
     VALUES ($1, 'reengage_dormant', true, $2, $3) RETURNING *`,
    [t.id, opts.managerEmail, opts.verified ? new Date() : null],
  );
  const p = await pool.query<PlayRow>(
    `INSERT INTO agent_plays (tenant_id, goal_id, status, risk_score, audience_snapshot, touches)
     VALUES ($1, $2, 'pending_approval', 50, '{"contact_ids":["c1"],"size":1}',
             '[{"index":0,"subject":"Hi","body_html":"<p>x</p>","scheduled_offset_days":0}]') RETURNING *`,
    [t.id, g.rows[0].id],
  );
  return { tenantId: t.id, goal: g.rows[0], play: p.rows[0] };
}

describe('escalatePlay', () => {
  it('sends an approval email + creates a row when the manager is verified', async () => {
    const { goal, play } = await seed({ verified: true, managerEmail: 'boss@x.io' });
    const res = await escalatePlay({ pool, encKey: cfg.encKey, baseUrl: cfg.publicBaseUrl, play, goal });
    expect(res.escalated).toBe(true);
    expect(await getActiveApprovalByPlay(pool, play.id)).not.toBeNull();
  });

  it('is idempotent — second call does not create a second active approval', async () => {
    const { goal, play } = await seed({ verified: true, managerEmail: 'boss@x.io' });
    await escalatePlay({ pool, encKey: cfg.encKey, baseUrl: cfg.publicBaseUrl, play, goal });
    const second = await escalatePlay({ pool, encKey: cfg.encKey, baseUrl: cfg.publicBaseUrl, play, goal });
    expect(second.escalated).toBe(false);
    expect(second.reason).toBe('already_escalated');
    const rows = await pool.query(`SELECT count(*)::int AS n FROM agent_approvals WHERE play_id = $1`, [play.id]);
    expect(rows.rows[0].n).toBe(1);
  });

  it('is a no-op when the manager is unverified', async () => {
    const { goal, play } = await seed({ verified: false, managerEmail: 'boss@x.io' });
    const res = await escalatePlay({ pool, encKey: cfg.encKey, baseUrl: cfg.publicBaseUrl, play, goal });
    expect(res.escalated).toBe(false);
    expect(res.reason).toBe('manager_unverified');
    expect(await getActiveApprovalByPlay(pool, play.id)).toBeNull();
  });

  it('is a no-op when no manager email is set', async () => {
    const { goal, play } = await seed({ verified: true, managerEmail: null });
    const res = await escalatePlay({ pool, encKey: cfg.encKey, baseUrl: cfg.publicBaseUrl, play, goal });
    expect(res.escalated).toBe(false);
    expect(res.reason).toBe('no_manager_email');
  });
});
