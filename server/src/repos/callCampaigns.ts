import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { AppError } from '../util/errors.js';
import type { ValuesField } from './callAgents.js';
import { listMembers } from './contactLists.js';
import { listSegmentContactIds } from './segments.js';
import type { SegmentFilter } from './segments.js';
import { getContactsByIds } from './contacts.js';

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

// ─── Recipient types ───────────────────────────────────────────────────────

export interface RecipientRow {
  id: string; tenant_id: string; campaign_id: string; suid: string;
  name: string; phone: string; timezone: string | null;
  values: Record<string, unknown>; contact_id: string | null;
  status: RecipientStatus; attempts: number; last_error: string | null;
  jobix_response: unknown; launched_at: Date | null; result_message_id: string | null;
  outcome: string | null; created_at: Date; updated_at: Date;
}

interface ResolvedRecipient {
  name: string; phone: string; values: Record<string, unknown>;
  contactId?: string | null; error?: string;
}

// ─── Private helpers ────────────────────────────────────────────────────────

async function agentSchema(pool: pg.Pool, tenantId: string, agentId: string): Promise<ValuesField[]> {
  const r = await pool.query<{ values_schema: ValuesField[] }>(
    `SELECT values_schema FROM call_agents WHERE tenant_id = $1 AND id = $2`, [tenantId, agentId]);
  return r.rows[0]?.values_schema ?? [];
}

function resolveValues(
  schema: ValuesField[],
  src: Record<string, unknown>,
): { values: Record<string, unknown>; missing: string[] } {
  const values: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const f of schema) {
    const v = src[f.key];
    if (v === undefined || v === null || v === '') {
      if (f.required) missing.push(f.key);
      continue;
    }
    values[f.key] = v;
  }
  return { values, missing };
}

async function insertRecipients(
  pool: pg.Pool,
  tenantId: string,
  campaignId: string,
  resolved: ResolvedRecipient[],
): Promise<{ added: number; errors: string[] }> {
  const errors: string[] = [];
  let added = 0;
  for (let i = 0; i < resolved.length; i++) {
    const r = resolved[i];
    if (r.error) { errors.push(`Row ${i + 1}: ${r.error}`); continue; }
    await pool.query(
      `INSERT INTO call_campaign_recipients (tenant_id, campaign_id, suid, name, phone, values, contact_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id, suid) DO NOTHING`,
      [tenantId, campaignId, randomUUID(), r.name, r.phone, JSON.stringify(r.values), r.contactId ?? null]);
    added++;
  }
  await pool.query(
    `UPDATE call_campaigns
     SET recipient_count = (SELECT COUNT(*) FROM call_campaign_recipients WHERE campaign_id = $1 AND tenant_id = $2),
         updated_at = now()
     WHERE id = $1 AND tenant_id = $2`,
    [campaignId, tenantId]);
  return { added, errors };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function addRecipientsFromCsv(
  pool: pg.Pool,
  args: { tenantId: string; campaignId: string; agentId: string; rows: Record<string, string>[] },
): Promise<{ added: number; errors: string[] }> {
  const schema = await agentSchema(pool, args.tenantId, args.agentId);
  const resolved: ResolvedRecipient[] = args.rows.map(row => {
    const name = (row.name ?? '').trim();
    const phone = (row.phone ?? '').trim();
    if (!name || !phone) return { name, phone, values: {}, error: 'missing name or phone' };
    const { values, missing } = resolveValues(schema, row as Record<string, unknown>);
    if (missing.length) return { name, phone, values, error: `missing required values: ${missing.join(', ')}` };
    return { name, phone, values };
  });
  return insertRecipients(pool, args.tenantId, args.campaignId, resolved);
}

export async function addRecipientsFromAudience(
  pool: pg.Pool,
  args: { tenantId: string; campaignId: string; agentId: string; audienceType: 'list' | 'segment'; audienceId: string },
): Promise<{ added: number; errors: string[] }> {
  const schema = await agentSchema(pool, args.tenantId, args.agentId);
  let contacts;
  if (args.audienceType === 'list') {
    contacts = await listMembers(pool, args.tenantId, args.audienceId);
  } else {
    const seg = await pool.query<{ filter: SegmentFilter }>(
      `SELECT filter FROM segments WHERE tenant_id = $1 AND id = $2`, [args.tenantId, args.audienceId]);
    if (!seg.rows[0]) throw new AppError('not_found', 404, 'Segment not found');
    const ids = await listSegmentContactIds(pool, args.tenantId, seg.rows[0].filter);
    contacts = await getContactsByIds(pool, args.tenantId, ids, false);
  }
  const resolved: ResolvedRecipient[] = contacts.map(ct => {
    const attrs = (ct.attributes ?? {}) as Record<string, unknown>;
    const name = (ct.name ?? '').toString().trim();
    const phone = (attrs.phone ?? '').toString().trim();
    if (!name || !phone) {
      return { name, phone, values: {}, contactId: ct.id, error: 'contact missing name or phone attribute' };
    }
    const { values, missing } = resolveValues(schema, attrs);
    if (missing.length) {
      return { name, phone, values, contactId: ct.id, error: `missing required values: ${missing.join(', ')}` };
    }
    return { name, phone, values, contactId: ct.id };
  });
  return insertRecipients(pool, args.tenantId, args.campaignId, resolved);
}

export async function listRecipients(
  pool: pg.Pool,
  tenantId: string,
  campaignId: string,
  opts: { status?: RecipientStatus; limit?: number; offset?: number },
): Promise<{ recipients: RecipientRow[]; total: number }> {
  const params: unknown[] = [tenantId, campaignId];
  let where = `tenant_id = $1 AND campaign_id = $2`;
  if (opts.status) {
    params.push(opts.status);
    where += ` AND status = $${params.length}`;
  }
  const total = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM call_campaign_recipients WHERE ${where}`, params);
  params.push(opts.limit ?? 100, opts.offset ?? 0);
  const r = await pool.query<RecipientRow>(
    `SELECT * FROM call_campaign_recipients WHERE ${where} ORDER BY created_at LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params);
  return { recipients: r.rows, total: Number(total.rows[0].n) };
}

export async function validateRecipients(
  pool: pg.Pool,
  tenantId: string,
  campaignId: string,
): Promise<{ ok: boolean; errors: string[] }> {
  const camp = await pool.query<{ agent_id: string }>(
    `SELECT agent_id FROM call_campaigns WHERE tenant_id = $1 AND id = $2`, [tenantId, campaignId]);
  if (!camp.rows[0]) throw new AppError('not_found', 404, 'Campaign not found');
  const schema = await agentSchema(pool, tenantId, camp.rows[0].agent_id);
  const required = schema.filter(f => f.required).map(f => f.key);
  const recips = await pool.query<{ id: string; phone: string; values: Record<string, unknown> }>(
    `SELECT id, phone, values FROM call_campaign_recipients WHERE campaign_id = $1 AND status NOT IN ('canceled')`,
    [campaignId]);
  const errors: string[] = [];
  for (const r of recips.rows) {
    if (!r.phone) errors.push(`Recipient ${r.id}: missing phone`);
    for (const key of required) {
      const v = (r.values ?? {})[key];
      if (v === undefined || v === null || v === '') {
        errors.push(`Recipient ${r.id}: missing required value ${key}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
