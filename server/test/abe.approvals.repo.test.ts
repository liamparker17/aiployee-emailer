// server/test/abe.approvals.repo.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import {
  createApproval, getActiveApprovalByPlay, consumeApproval,
} from '../src/repos/agentApprovals.js';

const pool = makePool();
beforeAll(async () => {});
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function seedPlay(tenantId: string): Promise<string> {
  const g = await pool.query(
    `INSERT INTO agent_goals (tenant_id, kind, enabled) VALUES ($1, 'reengage_dormant', true) RETURNING id`,
    [tenantId],
  );
  const p = await pool.query(
    `INSERT INTO agent_plays (tenant_id, goal_id, status, risk_score, audience_snapshot, touches)
     VALUES ($1, $2, 'pending_approval', 50, '{"contact_ids":[],"size":0}', '[]') RETURNING id`,
    [tenantId, g.rows[0].id],
  );
  return p.rows[0].id;
}

describe('agentApprovals repo', () => {
  it('creates and reads back an active (unconsumed) approval', async () => {
    const t = await createTenant(pool);
    const playId = await seedPlay(t.id);
    const expiresAt = new Date(Date.now() + 86_400_000);
    const row = await createApproval({
      pool, playId, tenantId: t.id, tokenHash: 'h'.repeat(64),
      managerEmail: 'boss@x.io', expiresAt,
    });
    expect(row.play_id).toBe(playId);
    expect(row.consumed_at).toBeNull();
    expect(row.decision).toBeNull();

    const active = await getActiveApprovalByPlay(pool, playId);
    expect(active!.id).toBe(row.id);
  });

  it('consume sets decision/decided_at/consumed_at and is single-use', async () => {
    const t = await createTenant(pool);
    const playId = await seedPlay(t.id);
    const row = await createApproval({
      pool, playId, tenantId: t.id, tokenHash: 'h'.repeat(64),
      managerEmail: 'boss@x.io', expiresAt: new Date(Date.now() + 86_400_000),
    });

    const first = await consumeApproval(pool, row.id, 'approve');
    expect(first!.decision).toBe('approve');
    expect(first!.consumed_at).not.toBeNull();
    expect(first!.decided_at).not.toBeNull();

    // Second consume returns null (already consumed) — single-use enforced in SQL.
    const second = await consumeApproval(pool, row.id, 'reject');
    expect(second).toBeNull();

    // No longer "active".
    expect(await getActiveApprovalByPlay(pool, playId)).toBeNull();
  });

  it('getActiveApprovalByPlay returns null when none exist', async () => {
    const t = await createTenant(pool);
    const playId = await seedPlay(t.id);
    expect(await getActiveApprovalByPlay(pool, playId)).toBeNull();
  });
});
