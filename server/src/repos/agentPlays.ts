import type pg from 'pg';

export interface Touch {
  index: number;
  subject: string;
  body_html: string;
  scheduled_offset_days: number;
}

export interface AudienceSnapshot {
  contact_ids: string[];
  size: number;
}

export type PlayStatus =
  | 'proposed' | 'pending_approval' | 'approved' | 'rejected' | 'executing' | 'done' | 'archived';

export interface PlayRow {
  id: string;
  tenant_id: string;
  goal_id: string;
  status: PlayStatus;
  risk_score: number;
  audience_snapshot: AudienceSnapshot;
  touches: Touch[];
  rejection_reason: string | null;
  executed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function insertPlay(
  pool: pg.Pool,
  args: { tenantId: string; goalId: string; riskScore: number; audienceSnapshot: AudienceSnapshot; touches: Touch[] },
): Promise<PlayRow> {
  const r = await pool.query<PlayRow>(
    `INSERT INTO agent_plays (tenant_id, goal_id, status, risk_score, audience_snapshot, touches)
     VALUES ($1, $2, 'proposed', $3, $4, $5)
     RETURNING *`,
    [args.tenantId, args.goalId, args.riskScore, JSON.stringify(args.audienceSnapshot), JSON.stringify(args.touches)],
  );
  return r.rows[0];
}

export async function getPlay(pool: pg.Pool, tenantId: string, id: string): Promise<PlayRow | null> {
  const r = await pool.query<PlayRow>(
    `SELECT * FROM agent_plays WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return r.rows[0] ?? null;
}

export async function listPlays(pool: pg.Pool, tenantId: string): Promise<PlayRow[]> {
  const r = await pool.query<PlayRow>(
    `SELECT * FROM agent_plays WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );
  return r.rows;
}
