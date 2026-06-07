import type pg from 'pg';
import { AppError } from '../util/errors.js';

export type CampaignStatus = 'draft' | 'approved' | 'running' | 'paused' | 'completed' | 'canceled';
export type RecipientStatus = 'pending' | 'queued' | 'launched' | 'failed' | 'suppressed' | 'completed' | 'canceled';

export interface CampaignRow {
  id: string; tenant_id: string; agent_id: string; name: string;
  audience_type: 'list' | 'segment' | 'csv'; audience_id: string | null;
  scheduled_for: Date | null; status: CampaignStatus; recipient_count: number;
  approved_by: string | null; approved_at: Date | null; created_by: string | null;
  created_at: Date; updated_at: Date;
}

export type CampaignCounts = Record<RecipientStatus, number>;
export interface CampaignWithCounts extends CampaignRow { counts: CampaignCounts }

const EMPTY_COUNTS: CampaignCounts = {
  pending: 0, queued: 0, launched: 0, failed: 0, suppressed: 0, completed: 0, canceled: 0,
};

interface CreateCampaignInput {
  tenantId: string; agentId: string; name: string;
  audienceType: 'list' | 'segment' | 'csv'; audienceId?: string | null;
  scheduledFor?: Date | null; createdBy?: string | null;
}

export async function createCampaign(pool: pg.Pool, input: CreateCampaignInput): Promise<CampaignRow> {
  const agent = await pool.query(
    `SELECT id, active FROM call_agents WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.agentId],
  );
  if (!agent.rows[0]) throw new AppError('not_found', 404, 'Agent not found');
  if (!agent.rows[0].active) throw new AppError('agent_inactive', 400, 'Agent is not active');
  const r = await pool.query<CampaignRow>(
    `INSERT INTO call_campaigns (tenant_id, agent_id, name, audience_type, audience_id, scheduled_for, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [input.tenantId, input.agentId, input.name, input.audienceType,
     input.audienceId ?? null, input.scheduledFor ?? null, input.createdBy ?? null],
  );
  return r.rows[0];
}

async function countsFor(pool: pg.Pool, campaignId: string): Promise<CampaignCounts> {
  const r = await pool.query<{ status: RecipientStatus; n: string }>(
    `SELECT status, COUNT(*)::text AS n FROM call_campaign_recipients WHERE campaign_id = $1 GROUP BY status`,
    [campaignId],
  );
  const counts: CampaignCounts = { ...EMPTY_COUNTS };
  for (const row of r.rows) counts[row.status] = Number(row.n);
  return counts;
}

export async function getCampaign(pool: pg.Pool, tenantId: string, id: string): Promise<CampaignWithCounts | null> {
  const r = await pool.query<CampaignRow>(
    `SELECT * FROM call_campaigns WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { ...row, counts: await countsFor(pool, id) };
}

export async function listCampaigns(pool: pg.Pool, tenantId: string): Promise<CampaignWithCounts[]> {
  const r = await pool.query<CampaignRow>(
    `SELECT * FROM call_campaigns WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );
  const out: CampaignWithCounts[] = [];
  for (const row of r.rows) out.push({ ...row, counts: await countsFor(pool, row.id) });
  return out;
}

async function transition(
  pool: pg.Pool,
  tenantId: string,
  id: string,
  from: CampaignStatus[],
  to: CampaignStatus,
): Promise<CampaignRow> {
  const r = await pool.query<CampaignRow>(
    `UPDATE call_campaigns SET status = $3, updated_at = now()
     WHERE tenant_id = $1 AND id = $2 AND status = ANY($4) RETURNING *`,
    [tenantId, id, to, from],
  );
  if (!r.rows[0]) {
    const exists = await pool.query(
      `SELECT status FROM call_campaigns WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    if (!exists.rows[0]) throw new AppError('not_found', 404, 'Campaign not found');
    throw new AppError('invalid_transition', 400, `Cannot move campaign from ${exists.rows[0].status} to ${to}`);
  }
  return r.rows[0];
}

export async function approveCampaign(
  pool: pg.Pool,
  tenantId: string,
  id: string,
  userId: string | null,
): Promise<CampaignRow> {
  const valid = await validateRecipients(pool, tenantId, id);
  if (!valid.ok) throw new AppError('validation_failed', 400, 'Campaign has invalid recipients', valid.errors);

  const count = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM call_campaign_recipients WHERE campaign_id = $1 AND status = 'pending'`,
    [id],
  );
  if (Number(count.rows[0].n) === 0) {
    throw new AppError('no_recipients', 400, 'Campaign has no recipients to launch');
  }

  // approved_by set via bound parameter — no string interpolation of userId
  const r = await pool.query<CampaignRow>(
    `UPDATE call_campaigns
     SET status = 'approved', approved_by = $3, approved_at = now(), updated_at = now()
     WHERE tenant_id = $1 AND id = $2 AND status = 'draft'
     RETURNING *`,
    [tenantId, id, userId ?? null],
  );
  if (!r.rows[0]) {
    const exists = await pool.query(
      `SELECT status FROM call_campaigns WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    if (!exists.rows[0]) throw new AppError('not_found', 404, 'Campaign not found');
    throw new AppError('invalid_transition', 400, `Cannot approve campaign from status ${exists.rows[0].status}`);
  }
  return r.rows[0];
}

export async function pauseCampaign(pool: pg.Pool, tenantId: string, id: string): Promise<CampaignRow> {
  return transition(pool, tenantId, id, ['approved', 'running'], 'paused');
}

export async function resumeCampaign(pool: pg.Pool, tenantId: string, id: string): Promise<CampaignRow> {
  return transition(pool, tenantId, id, ['paused'], 'approved');
}

export async function cancelCampaign(pool: pg.Pool, tenantId: string, id: string): Promise<CampaignRow> {
  return transition(pool, tenantId, id, ['draft', 'approved', 'running', 'paused'], 'canceled');
}

// TEMPORARY stub — replaced with the real implementation in Task 4.
export async function validateRecipients(
  _pool: pg.Pool,
  _tenantId: string,
  _id: string,
): Promise<{ ok: boolean; errors: string[] }> {
  return { ok: true, errors: [] };
}
