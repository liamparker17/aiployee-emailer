import type pg from 'pg';

export interface GoalRow {
  id: string;
  tenant_id: string;
  kind: 'reengage_dormant';
  enabled: boolean;
  schedule: 'daily';
  dormant_window_days: number;
  auto_fire_max_audience: number;
  max_touches: number;
  touch_spacing_days: number;
  line_manager_email: string | null;
  line_manager_verified_at: Date | null;
  brand_voice: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Sparse-patch semantics: an omitted field keeps the existing DB value.
 * Passing `null` for `lineManagerEmail` or `brandVoice` also keeps the existing
 * value — clearing a field is NOT supported in v1 (the COALESCE upsert treats
 * null as "no change").
 */
export interface GoalPatch {
  enabled?: boolean;
  dormantWindowDays?: number;
  autoFireMaxAudience?: number;
  maxTouches?: number;
  touchSpacingDays?: number;
  lineManagerEmail?: string | null;
  brandVoice?: string | null;
}

export async function getGoal(pool: pg.Pool, tenantId: string): Promise<GoalRow | null> {
  const r = await pool.query<GoalRow>(
    `SELECT * FROM agent_goals WHERE tenant_id = $1 AND kind = 'reengage_dormant'`,
    [tenantId],
  );
  return r.rows[0] ?? null;
}

// Cross-tenant query — intended for the scheduler/cron caller only (not tenant-scoped).
export async function listEnabledGoals(pool: pg.Pool): Promise<GoalRow[]> {
  const r = await pool.query<GoalRow>(
    `SELECT * FROM agent_goals WHERE enabled = true ORDER BY created_at ASC`,
  );
  return r.rows;
}

export async function upsertGoal(pool: pg.Pool, tenantId: string, patch: GoalPatch): Promise<GoalRow> {
  const r = await pool.query<GoalRow>(
    `INSERT INTO agent_goals
       (tenant_id, kind, enabled, dormant_window_days, auto_fire_max_audience,
        max_touches, touch_spacing_days, line_manager_email, brand_voice)
     VALUES ($1, 'reengage_dormant',
        COALESCE($2, false), COALESCE($3, 60), COALESCE($4, 0),
        COALESCE($5, 3), COALESCE($6, 3), $7, $8)
     ON CONFLICT (tenant_id, kind) DO UPDATE SET
        enabled                = COALESCE($2, agent_goals.enabled),
        dormant_window_days    = COALESCE($3, agent_goals.dormant_window_days),
        auto_fire_max_audience = COALESCE($4, agent_goals.auto_fire_max_audience),
        max_touches            = COALESCE($5, agent_goals.max_touches),
        touch_spacing_days     = COALESCE($6, agent_goals.touch_spacing_days),
        line_manager_email     = COALESCE($7, agent_goals.line_manager_email),
        brand_voice            = COALESCE($8, agent_goals.brand_voice),
        updated_at             = now()
     RETURNING *`,
    [
      tenantId,
      patch.enabled ?? null,
      patch.dormantWindowDays ?? null,
      patch.autoFireMaxAudience ?? null,
      patch.maxTouches ?? null,
      patch.touchSpacingDays ?? null,
      patch.lineManagerEmail ?? null,
      patch.brandVoice ?? null,
    ],
  );
  return r.rows[0];
}
