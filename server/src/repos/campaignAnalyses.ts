import type pg from 'pg';

// Phase 2 of Abe inbox intelligence: persistence for per-campaign reply analysis.
// campaign_analyses = one run with a funnel snapshot; reply_groups = clusters of
// replies that need the same response; assignment lives on inbound_emails.

export interface CampaignAnalysisRow {
  id: string;
  tenant_id: string;
  campaign_id: string;
  run_at: string;
  status: 'running' | 'ready' | 'failed';
  sent_count: number;
  opened_count: number;
  replied_count: number;
  hot_lead_count: number;
  model_cost_note: string | null;
  error: string | null;
}

export interface ReplyGroupRow {
  id: string;
  tenant_id: string;
  campaign_analysis_id: string;
  label: string;
  intent_summary: string | null;
  size: number;
  confidence: number | null;
  proposed_outline: string | null;
  kind: 'standard' | 'hot_leads' | 'needs_review';
  send_mode: 'batch' | 'individual' | null;
  draft_status: 'none' | 'drafted' | 'queued' | 'sent';
}

const ANALYSIS_COLS =
  'id, tenant_id, campaign_id, run_at, status, sent_count, opened_count, replied_count, hot_lead_count, model_cost_note, error';
const GROUP_COLS =
  'id, tenant_id, campaign_analysis_id, label, intent_summary, size, confidence, proposed_outline, kind, send_mode, draft_status';

export async function createAnalysis(pool: pg.Pool, tenantId: string, campaignId: string): Promise<CampaignAnalysisRow> {
  const r = await pool.query<CampaignAnalysisRow>(
    `INSERT INTO campaign_analyses(tenant_id, campaign_id) VALUES ($1,$2) RETURNING ${ANALYSIS_COLS}`,
    [tenantId, campaignId],
  );
  return r.rows[0];
}

export async function finishAnalysis(
  pool: pg.Pool, id: string,
  patch: {
    status: 'ready' | 'failed';
    sentCount?: number; openedCount?: number; repliedCount?: number; hotLeadCount?: number;
    modelCostNote?: string | null; error?: string | null;
  },
): Promise<void> {
  await pool.query(
    `UPDATE campaign_analyses SET status=$2, sent_count=COALESCE($3,sent_count), opened_count=COALESCE($4,opened_count),
       replied_count=COALESCE($5,replied_count), hot_lead_count=COALESCE($6,hot_lead_count),
       model_cost_note=$7, error=$8
     WHERE id=$1`,
    [id, patch.status, patch.sentCount ?? null, patch.openedCount ?? null, patch.repliedCount ?? null,
     patch.hotLeadCount ?? null, patch.modelCostNote ?? null, patch.error ?? null],
  );
}

export async function latestAnalysis(
  pool: pg.Pool, tenantId: string, campaignId: string,
): Promise<CampaignAnalysisRow | null> {
  const r = await pool.query<CampaignAnalysisRow>(
    `SELECT ${ANALYSIS_COLS} FROM campaign_analyses
     WHERE tenant_id=$1 AND campaign_id=$2 ORDER BY run_at DESC LIMIT 1`,
    [tenantId, campaignId],
  );
  return r.rows[0] ?? null;
}

export async function insertReplyGroup(
  pool: pg.Pool,
  input: {
    tenantId: string; analysisId: string; label: string; intentSummary?: string | null;
    size: number; confidence?: number | null; proposedOutline?: string | null;
    kind?: 'standard' | 'hot_leads' | 'needs_review';
  },
): Promise<ReplyGroupRow> {
  const r = await pool.query<ReplyGroupRow>(
    `INSERT INTO reply_groups(tenant_id, campaign_analysis_id, label, intent_summary, size, confidence, proposed_outline, kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${GROUP_COLS}`,
    [input.tenantId, input.analysisId, input.label, input.intentSummary ?? null, input.size,
     input.confidence ?? null, input.proposedOutline ?? null, input.kind ?? 'standard'],
  );
  return r.rows[0];
}

export async function listReplyGroups(pool: pg.Pool, tenantId: string, analysisId: string): Promise<ReplyGroupRow[]> {
  const r = await pool.query<ReplyGroupRow>(
    `SELECT ${GROUP_COLS} FROM reply_groups
     WHERE tenant_id=$1 AND campaign_analysis_id=$2 ORDER BY size DESC, label`,
    [tenantId, analysisId],
  );
  return r.rows;
}

export async function assignRepliesToGroup(
  pool: pg.Pool, tenantId: string, groupId: string, replyIds: string[],
  fit: 'fit' | 'misfit' | 'needs_review',
): Promise<void> {
  if (replyIds.length === 0) return;
  await pool.query(
    `UPDATE inbound_emails SET reply_group_id=$2, group_fit=$3, status='analyzed'
     WHERE tenant_id=$1 AND id = ANY($4::uuid[])`,
    [tenantId, groupId, fit, replyIds],
  );
}

export async function setHotLeads(pool: pg.Pool, tenantId: string, replyIds: string[]): Promise<void> {
  if (replyIds.length === 0) return;
  await pool.query(
    `UPDATE inbound_emails SET is_hot_lead=true WHERE tenant_id=$1 AND id = ANY($2::uuid[])`,
    [tenantId, replyIds],
  );
}

export interface CampaignFunnel { sent: number; opened: number; replied: number; hotLeads: number }

export async function campaignFunnel(pool: pg.Pool, tenantId: string, campaignId: string): Promise<CampaignFunnel> {
  const r = await pool.query<{ sent: number; opened: number; replied: number; hot_leads: number }>(
    `SELECT
       (SELECT count(*)::int FROM emails
        WHERE tenant_id=$1 AND campaign_id=$2 AND status IN ('sent','delivered')) AS sent,
       (SELECT count(DISTINCT ee.email_id)::int FROM email_events ee
        WHERE ee.type='open' AND ee.email_id IN (SELECT id FROM emails WHERE tenant_id=$1 AND campaign_id=$2)) AS opened,
       (SELECT count(*)::int FROM inbound_emails
        WHERE tenant_id=$1 AND campaign_id=$2) AS replied,
       (SELECT count(*)::int FROM inbound_emails
        WHERE tenant_id=$1 AND campaign_id=$2 AND is_hot_lead) AS hot_leads`,
    [tenantId, campaignId],
  );
  const row = r.rows[0];
  return { sent: row.sent, opened: row.opened, replied: row.replied, hotLeads: row.hot_leads };
}

export interface CampaignReplyRow {
  id: string;
  from_addr: string;
  from_name: string | null;
  subject: string | null;
  body_text: string | null;
  received_at: string;
  contact_id: string | null;
  embedding: number[] | null;
  is_hot_lead: boolean;
}

function parseVector(v: unknown): number[] | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v as number[];
  // pgvector returns its text form: "[0.1,0.2,...]" — valid JSON.
  if (typeof v === 'string') { try { return JSON.parse(v) as number[]; } catch { return null; } }
  return null;
}

export async function listCampaignReplies(pool: pg.Pool, tenantId: string, campaignId: string): Promise<CampaignReplyRow[]> {
  const r = await pool.query(
    `SELECT id, from_addr, from_name, subject, body_text, received_at, contact_id, embedding::text AS embedding, is_hot_lead
     FROM inbound_emails WHERE tenant_id=$1 AND campaign_id=$2 ORDER BY received_at`,
    [tenantId, campaignId],
  );
  return r.rows.map((row: Record<string, unknown>) => ({
    ...(row as unknown as CampaignReplyRow),
    embedding: parseVector(row.embedding),
  }));
}

export async function setReplyEmbedding(pool: pg.Pool, tenantId: string, id: string, embedding: number[]): Promise<void> {
  await pool.query(
    `UPDATE inbound_emails SET embedding = $3::vector WHERE tenant_id=$1 AND id=$2`,
    [tenantId, id, '[' + embedding.join(',') + ']'],
  );
}

export interface InboxSearchRow {
  id: string; from_addr: string; from_name: string | null; subject: string | null;
  received_at: string; campaign_id: string | null; snippet: string | null;
}

export async function searchInbox(
  pool: pg.Pool, tenantId: string, opts: { query: string; days?: number; limit?: number },
): Promise<InboxSearchRow[]> {
  const days = Math.min(Math.max(opts.days ?? 90, 1), 365);
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  const r = await pool.query<InboxSearchRow>(
    `SELECT id, from_addr, from_name, subject, received_at, campaign_id, left(body_text, 240) AS snippet
     FROM inbound_emails
     WHERE tenant_id=$1 AND received_at > now() - ($3 || ' days')::interval
       AND (subject ILIKE $2 OR body_text ILIKE $2 OR from_addr ILIKE $2 OR from_name ILIKE $2)
     ORDER BY received_at DESC LIMIT $4`,
    [tenantId, `%${opts.query}%`, String(days), limit],
  );
  return r.rows;
}

export interface InboundEmailFull {
  id: string; from_addr: string; from_name: string | null; to_addr: string | null;
  subject: string | null; body_text: string | null; received_at: string;
  email_id: string | null; campaign_id: string | null; contact_id: string | null;
  reply_group_id: string | null; group_fit: string | null; is_hot_lead: boolean; status: string;
}

export async function getInboundEmail(pool: pg.Pool, tenantId: string, id: string): Promise<InboundEmailFull | null> {
  const r = await pool.query<InboundEmailFull>(
    `SELECT id, from_addr, from_name, to_addr, subject, body_text, received_at,
            email_id, campaign_id, contact_id, reply_group_id, group_fit, is_hot_lead, status
     FROM inbound_emails WHERE tenant_id=$1 AND id=$2`,
    [tenantId, id],
  );
  return r.rows[0] ?? null;
}

export async function getReplyGroup(pool: pg.Pool, tenantId: string, id: string): Promise<ReplyGroupRow | null> {
  const r = await pool.query<ReplyGroupRow>(
    `SELECT ${GROUP_COLS} FROM reply_groups WHERE tenant_id=$1 AND id=$2`,
    [tenantId, id],
  );
  return r.rows[0] ?? null;
}

export async function setGroupDraft(
  pool: pg.Pool, tenantId: string, id: string,
  patch: { sendMode: 'batch' | 'individual'; draftStatus: 'drafted' | 'queued' | 'sent' },
): Promise<void> {
  await pool.query(
    `UPDATE reply_groups SET send_mode=$3, draft_status=$4 WHERE tenant_id=$1 AND id=$2`,
    [tenantId, id, patch.sendMode, patch.draftStatus],
  );
}

export interface GroupMemberRow {
  id: string; from_addr: string; from_name: string | null;
  subject: string | null; body_text: string | null; contact_id: string | null;
}

export async function listGroupMembers(
  pool: pg.Pool, tenantId: string, groupId: string, fit: 'fit' | 'misfit' | 'needs_review' = 'fit',
): Promise<GroupMemberRow[]> {
  const r = await pool.query<GroupMemberRow>(
    `SELECT id, from_addr, from_name, subject, body_text, contact_id
     FROM inbound_emails WHERE tenant_id=$1 AND reply_group_id=$2 AND group_fit=$3
     ORDER BY received_at`,
    [tenantId, groupId, fit],
  );
  return r.rows;
}

export async function listGroupMemberIds(
  pool: pg.Pool, tenantId: string, groupId: string, fit: 'fit' | 'misfit' | 'needs_review' = 'fit',
): Promise<string[]> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM inbound_emails WHERE tenant_id=$1 AND reply_group_id=$2 AND group_fit=$3`,
    [tenantId, groupId, fit],
  );
  return r.rows.map(x => x.id);
}
