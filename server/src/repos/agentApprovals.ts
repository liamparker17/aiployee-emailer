import type pg from 'pg';

export type ApprovalDecision = 'approve' | 'reject' | 'edit';

export interface ApprovalRow {
  id: string;
  play_id: string;
  tenant_id: string;
  token_hash: string;
  manager_email: string;
  channel: 'button' | 'reply';
  decision: ApprovalDecision | null;
  decided_at: Date | null;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
}

export async function createApproval(args: {
  pool: pg.Pool;
  playId: string;
  tenantId: string;
  tokenHash: string;
  managerEmail: string;
  expiresAt: Date;
}): Promise<ApprovalRow> {
  const r = await args.pool.query<ApprovalRow>(
    `INSERT INTO agent_approvals (play_id, tenant_id, token_hash, manager_email, channel, expires_at)
     VALUES ($1, $2, $3, $4, 'button', $5)
     RETURNING *`,
    [args.playId, args.tenantId, args.tokenHash, args.managerEmail, args.expiresAt],
  );
  return r.rows[0];
}

// Most-recent unconsumed approval for a play (idempotency + decision-route lookups).
export async function getActiveApprovalByPlay(pool: pg.Pool, playId: string): Promise<ApprovalRow | null> {
  const r = await pool.query<ApprovalRow>(
    `SELECT * FROM agent_approvals
     WHERE play_id = $1 AND consumed_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [playId],
  );
  return r.rows[0] ?? null;
}

// Single-use: only consumes a row that is still unconsumed; returns null otherwise.
export async function consumeApproval(
  pool: pg.Pool,
  approvalId: string,
  decision: ApprovalDecision,
): Promise<ApprovalRow | null> {
  const r = await pool.query<ApprovalRow>(
    `UPDATE agent_approvals
        SET decision = $2, decided_at = now(), consumed_at = now()
      WHERE id = $1 AND consumed_at IS NULL
      RETURNING *`,
    [approvalId, decision],
  );
  return r.rows[0] ?? null;
}
