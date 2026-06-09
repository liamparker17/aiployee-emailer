// server/test/abe.approveRoute.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createSmtpConfig } from '../src/repos/smtpConfigs.js';
import { createSender } from '../src/repos/senders.js';
import { startTestSmtp } from './helpers/smtp.js';
import type { PlayRow } from '../src/repos/agentPlays.js';
import { getPlay } from '../src/repos/agentPlays.js';
import { createApproval, getActiveApprovalByPlay } from '../src/repos/agentApprovals.js';
import { signApprovalToken, hashToken } from '../src/agent/abe/approvalToken.js';

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

beforeAll(async () => { smtp = startTestSmtp(2534); app = await buildApp({ cfg }); });
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await smtp.close(); await pool.end(); });

// Seeds a pending_approval play + a default sender + an approval row whose token_hash
// matches `token`. Returns { play, token }.
async function seedApproval(expiresMs = Date.now() + 60_000): Promise<{ play: PlayRow; token: string }> {
  const t = await createTenant(pool);
  const sc = await createSmtpConfig(pool, KEY, {
    tenantId: t.id, name: 'local', host: '127.0.0.1', port: 2534, secure: false,
    username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
  });
  await createSender(pool, { tenantId: t.id, email: 'abe@x.com', displayName: 'Abe', smtpConfigId: sc.id, isDefault: true });
  const g = await pool.query(
    `INSERT INTO agent_goals (tenant_id, kind, enabled) VALUES ($1, 'reengage_dormant', true) RETURNING id`,
    [t.id],
  );
  const p = await pool.query<PlayRow>(
    `INSERT INTO agent_plays (tenant_id, goal_id, status, risk_score, audience_snapshot, touches)
     VALUES ($1, $2, 'pending_approval', 50, '{"contact_ids":[],"size":0}',
             '[{"index":0,"subject":"Hi","body_html":"<p>x</p>","scheduled_offset_days":0}]') RETURNING *`,
    [t.id, g.rows[0].id],
  );
  const play = p.rows[0];
  const token = signApprovalToken(play.id, expiresMs, KEY);
  await createApproval({
    pool, playId: play.id, tenantId: t.id, tokenHash: hashToken(token),
    managerEmail: 'boss@x.io', expiresAt: new Date(expiresMs),
  });
  return { play, token };
}

const url = (tok: string, d: string) => `/v1/agent/approve/${encodeURIComponent(tok)}?d=${d}`;

describe('public approve/reject/view route', () => {
  it('approve consumes the token and moves the play off pending_approval', async () => {
    const { play, token } = await seedApproval();
    const r = await app.inject({ method: 'GET', url: url(token, 'approve') });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    const after = await getPlay(pool, play.tenant_id, play.id);
    expect(['approved', 'executing', 'done']).toContain(after!.status);
    expect(await getActiveApprovalByPlay(pool, play.id)).toBeNull(); // consumed
  });

  it('reject marks the play rejected and consumes the token', async () => {
    const { play, token } = await seedApproval();
    const r = await app.inject({ method: 'GET', url: url(token, 'reject') });
    expect(r.statusCode).toBe(200);
    const after = await getPlay(pool, play.tenant_id, play.id);
    expect(after!.status).toBe('rejected');
    expect(await getActiveApprovalByPlay(pool, play.id)).toBeNull();
  });

  it('a reused token is rejected (single-use)', async () => {
    const { token } = await seedApproval();
    await app.inject({ method: 'GET', url: url(token, 'approve') });
    const second = await app.inject({ method: 'GET', url: url(token, 'approve') });
    expect(second.statusCode).toBe(400);
  });

  it('an expired token is rejected and the play is untouched', async () => {
    const { play, token } = await seedApproval(Date.now() - 1);
    const r = await app.inject({ method: 'GET', url: url(token, 'approve') });
    expect(r.statusCode).toBe(400);
    const after = await getPlay(pool, play.tenant_id, play.id);
    expect(after!.status).toBe('pending_approval');
  });

  it('view renders the summary without consuming the token', async () => {
    const { play, token } = await seedApproval();
    const r = await app.inject({ method: 'GET', url: url(token, 'view') });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('Approve');
    // still consumable afterwards
    expect(await getActiveApprovalByPlay(pool, play.id)).not.toBeNull();
  });

  it('an invalid decision param is rejected', async () => {
    const { token } = await seedApproval();
    const r = await app.inject({ method: 'GET', url: url(token, 'bogus') });
    expect(r.statusCode).toBe(400);
  });
});
