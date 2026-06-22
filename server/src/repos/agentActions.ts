// server/src/repos/agentActions.ts
import pg from 'pg';

export type AgentActionType = 'send_reply'|'send_follow_up'|'create_callback_task'|'create_handover'|'mark_hot_lead'|'assign_owner'|'pause_sequence'|'resume_sequence'|'escalate_thread'|'send_client_update';
export type ActionStatus = 'pending'|'approved'|'rejected'|'executed'|'snoozed';
export type Level = 'low'|'medium'|'high';

export interface AgentActionRow {
  id: string; tenant_id: string; thread_id: string | null; campaign_id: string | null; contact_id: string | null;
  action_type: AgentActionType; title: string; draft_subject: string | null; draft_body: string | null;
  recommended_by: string; reason: string | null; confidence: number | null; risk_level: Level;
  source_refs: unknown; status: ActionStatus; assigned_to_user_id: string | null;
  approved_by_user_id: string | null; approved_at: Date | null; snoozed_until: Date | null;
  edited_payload: unknown; executed_at: Date | null; created_at: Date; updated_at: Date;
}

export interface CreateActionInput {
  tenantId: string; threadId: string | null; campaignId: string | null; contactId: string | null;
  actionType: AgentActionType; title: string; draftSubject?: string | null; draftBody?: string | null;
  reason?: string | null; confidence?: number | null; riskLevel?: Level; sourceRefs?: Record<string, unknown>;
}

const SELECT = `id, tenant_id, thread_id, campaign_id, contact_id, action_type, title, draft_subject, draft_body,
  recommended_by, reason, confidence, risk_level, source_refs, status, assigned_to_user_id,
  approved_by_user_id, approved_at, snoozed_until, edited_payload, executed_at, created_at, updated_at`;

export async function createAction(pool: pg.Pool, input: CreateActionInput): Promise<AgentActionRow> {
  const r = await pool.query<AgentActionRow>(
    `INSERT INTO agent_actions(tenant_id, thread_id, campaign_id, contact_id, action_type, title,
       draft_subject, draft_body, reason, confidence, risk_level, source_refs)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
     RETURNING ${SELECT}`,
    [input.tenantId, input.threadId, input.campaignId, input.contactId, input.actionType, input.title,
      input.draftSubject ?? null, input.draftBody ?? null, input.reason ?? null, input.confidence ?? null,
      input.riskLevel ?? 'medium', JSON.stringify(input.sourceRefs ?? {})],
  );
  return r.rows[0];
}

export async function getAction(pool: pg.Pool, tenantId: string, id: string): Promise<AgentActionRow | null> {
  const r = await pool.query<AgentActionRow>(`SELECT ${SELECT} FROM agent_actions WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  return r.rows[0] ?? null;
}

export async function listActions(
  pool: pg.Pool, tenantId: string, filter: { status?: ActionStatus; limit?: number },
): Promise<AgentActionRow[]> {
  const where = ['tenant_id = $1']; const params: unknown[] = [tenantId];
  if (filter.status) { params.push(filter.status); where.push(`status = $${params.length}`); }
  params.push(filter.limit ?? 200);
  const r = await pool.query<AgentActionRow>(
    `SELECT ${SELECT} FROM agent_actions WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}

export async function approveAction(pool: pg.Pool, tenantId: string, id: string, userId: string): Promise<void> {
  await pool.query(
    `UPDATE agent_actions SET status='approved', approved_by_user_id=$3, approved_at=now(), updated_at=now()
     WHERE tenant_id=$1 AND id=$2`, [tenantId, id, userId]);
}

export async function rejectAction(pool: pg.Pool, tenantId: string, id: string): Promise<void> {
  await pool.query(
    `UPDATE agent_actions SET status='rejected', updated_at=now() WHERE tenant_id=$1 AND id=$2`,
    [tenantId, id]);
}

export async function editActionDraft(pool: pg.Pool, tenantId: string, id: string, payload: { subject?: string; body?: string }): Promise<void> {
  await pool.query(
    `UPDATE agent_actions SET edited_payload=$3::jsonb, updated_at=now() WHERE tenant_id=$1 AND id=$2`,
    [tenantId, id, JSON.stringify(payload)]);
}

export async function assignAction(pool: pg.Pool, tenantId: string, id: string, assigneeUserId: string): Promise<void> {
  await pool.query(
    `UPDATE agent_actions SET assigned_to_user_id=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2`,
    [tenantId, id, assigneeUserId]);
}

export async function snoozeAction(pool: pg.Pool, tenantId: string, id: string, until: Date): Promise<void> {
  await pool.query(
    `UPDATE agent_actions SET status='snoozed', snoozed_until=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2`,
    [tenantId, id, until]);
}

export async function markActionExecuted(pool: pg.Pool, tenantId: string, id: string): Promise<void> {
  await pool.query(
    `UPDATE agent_actions SET status='executed', executed_at=now(), updated_at=now() WHERE tenant_id=$1 AND id=$2`,
    [tenantId, id]);
}
