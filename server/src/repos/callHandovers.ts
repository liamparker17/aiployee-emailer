import type pg from 'pg';

export type Urgency = 'low'|'med'|'high';
export type HandoverStatus = 'pending'|'forwarded'|'dismissed';

export interface HandoverRow {
  id: string; tenant_id: string; message_id: string;
  caller_name: string | null; caller_phone: string | null; account_ref: string | null;
  reason_category: string; summary: string; recommended_action: string;
  urgency: Urgency; vulnerable: boolean; missing_fields: string[]; repeat_of: string | null;
  status: HandoverStatus; approved_by: string | null; forwarded_at: Date | null;
  email_id: string | null; dismiss_reason: string | null; created_at: Date;
}
export interface InboundRow { id: string; content: string; created_at: Date; }

export async function insertHandover(pool: pg.Pool, a: {
  tenantId: string; messageId: string; callerName?: string | null; callerPhone?: string | null;
  accountRef?: string | null; reasonCategory: string; summary: string; recommendedAction: string;
  urgency: Urgency; vulnerable: boolean; missingFields: string[]; repeatOf?: string | null;
  status?: HandoverStatus; dismissReason?: string | null;
}): Promise<HandoverRow> {
  const r = await pool.query<HandoverRow>(
    `INSERT INTO call_handovers
       (tenant_id, message_id, caller_name, caller_phone, account_ref, reason_category, summary,
        recommended_action, urgency, vulnerable, missing_fields, repeat_of, status, dismiss_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13,'pending'),$14)
     ON CONFLICT (message_id) DO NOTHING
     RETURNING *`,
    [a.tenantId, a.messageId, a.callerName ?? null, a.callerPhone ?? null, a.accountRef ?? null,
     a.reasonCategory, a.summary, a.recommendedAction, a.urgency, a.vulnerable,
     JSON.stringify(a.missingFields), a.repeatOf ?? null, a.status ?? null, a.dismissReason ?? null]);
  if (r.rows[0]) return r.rows[0];
  const ex = await pool.query<HandoverRow>(`SELECT * FROM call_handovers WHERE message_id=$1`, [a.messageId]);
  return ex.rows[0];
}

export async function listHandovers(pool: pg.Pool, tenantId: string, status?: HandoverStatus): Promise<HandoverRow[]> {
  if (status === 'pending') {
    const r = await pool.query<HandoverRow>(
      `SELECT * FROM call_handovers WHERE tenant_id=$1 AND status='pending'
       ORDER BY CASE urgency WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END, created_at ASC`, [tenantId]);
    return r.rows;
  }
  const r = status
    ? await pool.query<HandoverRow>(`SELECT * FROM call_handovers WHERE tenant_id=$1 AND status=$2 ORDER BY created_at DESC, id DESC`, [tenantId, status])
    : await pool.query<HandoverRow>(`SELECT * FROM call_handovers WHERE tenant_id=$1 ORDER BY created_at DESC, id DESC`, [tenantId]);
  return r.rows;
}

export async function getHandover(pool: pg.Pool, tenantId: string, id: string): Promise<HandoverRow | null> {
  const r = await pool.query<HandoverRow>(`SELECT * FROM call_handovers WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  return r.rows[0] ?? null;
}

export async function setHandoverStatus(
  pool: pg.Pool, tenantId: string, id: string, status: HandoverStatus,
  extra?: { emailId?: string; approvedBy?: string; dismissReason?: string },
): Promise<HandoverRow | null> {
  const r = await pool.query<HandoverRow>(
    `UPDATE call_handovers SET status=$3,
        approved_by    = COALESCE($4, approved_by),
        forwarded_at   = CASE WHEN $3='forwarded' THEN now() ELSE forwarded_at END,
        email_id       = COALESCE($5, email_id),
        dismiss_reason = COALESCE($6, dismiss_reason)
      WHERE tenant_id=$1 AND id=$2 RETURNING *`,
    [tenantId, id, status, extra?.approvedBy ?? null, extra?.emailId ?? null, extra?.dismissReason ?? null]);
  return r.rows[0] ?? null;
}

export async function listUnextractedInbound(pool: pg.Pool, tenantId: string, limit: number): Promise<InboundRow[]> {
  const r = await pool.query<InboundRow>(
    `SELECT m.id, m.content, m.created_at FROM agent_messages m
       LEFT JOIN call_handovers h ON h.message_id = m.id
      WHERE m.tenant_id=$1 AND m.role='inbound' AND h.id IS NULL
      ORDER BY m.created_at ASC LIMIT $2`, [tenantId, limit]);
  return r.rows;
}

export async function findRecentByCaller(
  pool: pg.Pool, tenantId: string, phone: string | null, accountRef: string | null, sinceDays: number,
): Promise<HandoverRow | null> {
  if (!phone && !accountRef) return null;
  const r = await pool.query<HandoverRow>(
    `SELECT * FROM call_handovers
      WHERE tenant_id=$1 AND created_at >= now() - ($4 || ' days')::interval
        AND ( ($2::text IS NOT NULL AND caller_phone = $2) OR ($3::text IS NOT NULL AND account_ref = $3) )
      ORDER BY created_at DESC LIMIT 1`, [tenantId, phone, accountRef, String(sinceDays)]);
  return r.rows[0] ?? null;
}
