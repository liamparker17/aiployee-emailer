// server/src/repos/agentThreads.ts
import pg from 'pg';

export type ThreadStage = 'new_reply'|'needs_triage'|'needs_human_reply'|'draft_ready'|'awaiting_customer'|'follow_up_due'|'escalated'|'converted'|'lost'|'closed'|'unsubscribed';
export type ThreadIntent = 'interested'|'pricing_request'|'booking_request'|'callback_request'|'not_interested'|'objection'|'complaint'|'wrong_person'|'out_of_office'|'unsubscribe_intent'|'admin_query'|'unknown';
export type ThreadSentiment = 'positive'|'neutral'|'negative';
export type Level = 'low'|'medium'|'high';
export type ObjectionType = 'price'|'timing'|'trust'|'confusion'|'other';
export type ThreadStatus = 'open'|'closed';

export interface ThreadRow {
  id: string; tenant_id: string; contact_id: string | null; campaign_id: string | null;
  latest_inbound_email_id: string | null; latest_outbound_email_id: string | null;
  stage: ThreadStage; intent: ThreadIntent | null; sentiment: ThreadSentiment | null;
  urgency: Level | null; lead_score: number | null; objection_type: ObjectionType | null;
  commercial_value: Level | null; owner_user_id: string | null; next_action: string | null;
  next_action_due_at: Date | null; status: ThreadStatus; source: string; confidence: number | null;
  last_agent_analysis_at: Date | null; created_at: Date; updated_at: Date;
}

export interface ThreadAnalysisInput {
  stage: ThreadStage; intent: ThreadIntent; sentiment: ThreadSentiment; urgency: Level;
  leadScore: number; objectionType: ObjectionType | null; commercialValue: Level;
  nextAction: string | null; nextActionDueAt: Date | null; confidence: number; status: ThreadStatus;
}

export interface ThreadContext {
  thread: ThreadRow;
  from_addr: string; from_name: string | null; inbound_subject: string | null; inbound_body: string | null;
  campaign_name: string | null; campaign_subject: string | null;
}

const SELECT = `id, tenant_id, contact_id, campaign_id, latest_inbound_email_id, latest_outbound_email_id,
  stage, intent, sentiment, urgency, lead_score, objection_type, commercial_value, owner_user_id,
  next_action, next_action_due_at, status, source, confidence, last_agent_analysis_at, created_at, updated_at`;

const ZERO_UUID = `'00000000-0000-0000-0000-000000000000'::uuid`;

/** Upsert one thread per (tenant, contact, campaign) from correlated inbound replies. Idempotent. */
export async function upsertThreadsFromReplies(pool: pg.Pool): Promise<number> {
  const r = await pool.query(
    `INSERT INTO agent_threads (tenant_id, contact_id, campaign_id, latest_inbound_email_id, source, stage)
     SELECT DISTINCT ON (e.tenant_id, e.contact_id, COALESCE(e.campaign_id, ${ZERO_UUID}))
            e.tenant_id, e.contact_id, e.campaign_id, e.id,
            CASE WHEN e.campaign_id IS NOT NULL THEN 'campaign_reply' ELSE 'inbound' END,
            'needs_triage'
       FROM inbound_emails e
      WHERE e.contact_id IS NOT NULL
      ORDER BY e.tenant_id, e.contact_id, COALESCE(e.campaign_id, ${ZERO_UUID}), e.received_at DESC
     ON CONFLICT (tenant_id, contact_id, COALESCE(campaign_id, ${ZERO_UUID}))
     DO UPDATE SET
       latest_inbound_email_id = EXCLUDED.latest_inbound_email_id,
       stage = CASE WHEN agent_threads.stage IN ('converted','lost','closed','unsubscribed')
                    THEN agent_threads.stage ELSE 'needs_triage' END,
       updated_at = now()
     WHERE agent_threads.latest_inbound_email_id IS DISTINCT FROM EXCLUDED.latest_inbound_email_id`,
  );
  return r.rowCount ?? 0;
}

export async function getThread(pool: pg.Pool, tenantId: string, id: string): Promise<ThreadRow | null> {
  const r = await pool.query<ThreadRow>(`SELECT ${SELECT} FROM agent_threads WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return r.rows[0] ?? null;
}

export async function listThreads(
  pool: pg.Pool, tenantId: string,
  filter: { stage?: ThreadStage; status?: ThreadStatus; dueBefore?: Date; ownerId?: string; limit?: number },
): Promise<ThreadRow[]> {
  const where: string[] = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  if (filter.stage)    { params.push(filter.stage);    where.push(`stage = $${params.length}`); }
  if (filter.status)   { params.push(filter.status);   where.push(`status = $${params.length}`); }
  if (filter.ownerId)  { params.push(filter.ownerId);  where.push(`owner_user_id = $${params.length}`); }
  if (filter.dueBefore){ params.push(filter.dueBefore);where.push(`next_action_due_at <= $${params.length}`); }
  params.push(filter.limit ?? 200);
  const r = await pool.query<ThreadRow>(
    `SELECT ${SELECT} FROM agent_threads WHERE ${where.join(' AND ')}
     ORDER BY next_action_due_at ASC NULLS LAST, updated_at DESC LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}

export async function applyThreadAnalysis(pool: pg.Pool, tenantId: string, id: string, a: ThreadAnalysisInput): Promise<void> {
  await pool.query(
    `UPDATE agent_threads SET
       stage=$3, intent=$4, sentiment=$5, urgency=$6, lead_score=$7, objection_type=$8,
       commercial_value=$9, next_action=$10, next_action_due_at=$11, confidence=$12, status=$13,
       last_agent_analysis_at=now(), updated_at=now()
     WHERE tenant_id=$1 AND id=$2`,
    [tenantId, id, a.stage, a.intent, a.sentiment, a.urgency, a.leadScore, a.objectionType,
      a.commercialValue, a.nextAction, a.nextActionDueAt, a.confidence, a.status],
  );
}

/** Cross-tenant: open threads whose latest inbound is newer than their last analysis. Drives the cron. */
export async function listThreadsNeedingAnalysis(pool: pg.Pool, limit: number): Promise<Array<{ tenant_id: string; thread_id: string }>> {
  const r = await pool.query<{ tenant_id: string; thread_id: string }>(
    `SELECT t.tenant_id, t.id AS thread_id
       FROM agent_threads t
       JOIN inbound_emails e ON e.id = t.latest_inbound_email_id
      WHERE t.status = 'open'
        AND (t.last_agent_analysis_at IS NULL OR e.received_at > t.last_agent_analysis_at)
      ORDER BY e.received_at ASC
      LIMIT $1`,
    [limit],
  );
  return r.rows;
}

export async function getThreadContext(pool: pg.Pool, tenantId: string, id: string): Promise<ThreadContext | null> {
  const r = await pool.query<ThreadRow & {
    from_addr: string; from_name: string | null; inbound_subject: string | null; inbound_body: string | null;
    campaign_name: string | null; campaign_subject: string | null;
  }>(
    `SELECT ${SELECT.split(',').map(c => 't.' + c.trim()).join(', ')},
            e.from_addr, e.from_name, e.subject AS inbound_subject, e.body_text AS inbound_body,
            c.name AS campaign_name, c.subject AS campaign_subject
       FROM agent_threads t
       JOIN inbound_emails e ON e.id = t.latest_inbound_email_id
       LEFT JOIN campaigns c ON c.id = t.campaign_id
      WHERE t.tenant_id = $1 AND t.id = $2`,
    [tenantId, id],
  );
  const row = r.rows[0];
  if (!row) return null;
  const { from_addr, from_name, inbound_subject, inbound_body, campaign_name, campaign_subject, ...thread } = row;
  return { thread: thread as ThreadRow, from_addr, from_name, inbound_subject, inbound_body, campaign_name, campaign_subject };
}

export async function getReplyDispatchInfo(
  pool: pg.Pool, tenantId: string, id: string,
): Promise<{ to_addr: string; sender_id: string | null; campaign_id: string | null } | null> {
  const r = await pool.query<{ to_addr: string; sender_id: string | null; campaign_id: string | null }>(
    `SELECT e.from_addr AS to_addr,
            COALESCE(camp.sender_id, def.id) AS sender_id,
            t.campaign_id
       FROM agent_threads t
       JOIN inbound_emails e ON e.id = t.latest_inbound_email_id
       LEFT JOIN campaigns camp ON camp.id = t.campaign_id
       LEFT JOIN LATERAL (SELECT id FROM senders WHERE tenant_id = t.tenant_id AND is_default = true LIMIT 1) def ON true
      WHERE t.tenant_id = $1 AND t.id = $2`,
    [tenantId, id],
  );
  return r.rows[0] ?? null;
}

export async function setThreadAfterSend(pool: pg.Pool, tenantId: string, id: string, outboundEmailId: string): Promise<void> {
  await pool.query(
    `UPDATE agent_threads SET latest_outbound_email_id=$3, stage='awaiting_customer', status='open', updated_at=now()
     WHERE tenant_id=$1 AND id=$2`,
    [tenantId, id, outboundEmailId],
  );
}

export async function setThreadOwner(pool: pg.Pool, tenantId: string, id: string, ownerUserId: string): Promise<void> {
  await pool.query(`UPDATE agent_threads SET owner_user_id=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2`, [tenantId, id, ownerUserId]);
}
