import type pg from 'pg';

export type ReportType = 'digest' | 'alert' | 'answer' | 'case';
export type ReportStatus = 'pending_approval' | 'approved' | 'sent' | 'rejected' | 'archived';
export type Urgency = 'low' | 'med' | 'high';

export interface Advisory {
  diagnosis: string;
  root_cause_hypothesis: string | null;
  recommended_actions: Array<{ action: string; owner: string; urgency: Urgency }>;
  draft_comms: { customer_message: string; internal_note: string; talking_points: string[] };
}

export const EMPTY_ADVISORY: Advisory = {
  diagnosis: '',
  root_cause_hypothesis: null,
  recommended_actions: [],
  draft_comms: { customer_message: '', internal_note: '', talking_points: [] },
};

export interface LineReportRow {
  id: string;
  tenant_id: string;
  report_type: ReportType;
  period_start: Date | null;
  period_end: Date | null;
  status: ReportStatus;
  subject: string;
  body: string;
  metrics: Record<string, unknown>;
  advisory: Advisory;
  source_message_ids: string[];
  approved_by: string | null;
  approved_at: Date | null;
  sent_at: Date | null;
  email_id: string | null;
  reject_reason: string | null;
  created_at: Date;
}

export async function insertReport(pool: pg.Pool, a: {
  tenantId: string;
  reportType: ReportType;
  subject: string;
  body: string;
  metrics: Record<string, unknown>;
  advisory?: Advisory;
  sourceMessageIds: string[];
  periodStart?: Date | null;
  periodEnd?: Date | null;
}): Promise<LineReportRow> {
  const r = await pool.query<LineReportRow>(
    `INSERT INTO line_reports (tenant_id, report_type, subject, body, metrics, advisory, source_message_ids, period_start, period_end)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      a.tenantId, a.reportType, a.subject, a.body,
      JSON.stringify(a.metrics),
      JSON.stringify(a.advisory ?? EMPTY_ADVISORY),
      JSON.stringify(a.sourceMessageIds),
      a.periodStart ?? null, a.periodEnd ?? null,
    ],
  );
  return r.rows[0];
}

export async function listReports(pool: pg.Pool, tenantId: string, status?: ReportStatus): Promise<LineReportRow[]> {
  const r = status
    ? await pool.query<LineReportRow>(
        `SELECT * FROM line_reports WHERE tenant_id=$1 AND status=$2 ORDER BY created_at DESC, id DESC`,
        [tenantId, status],
      )
    : await pool.query<LineReportRow>(
        `SELECT * FROM line_reports WHERE tenant_id=$1 ORDER BY created_at DESC, id DESC`,
        [tenantId],
      );
  return r.rows;
}

export async function getReport(pool: pg.Pool, tenantId: string, id: string): Promise<LineReportRow | null> {
  const r = await pool.query<LineReportRow>(
    `SELECT * FROM line_reports WHERE tenant_id=$1 AND id=$2`,
    [tenantId, id],
  );
  return r.rows[0] ?? null;
}

export async function setReportStatus(
  pool: pg.Pool,
  tenantId: string,
  id: string,
  status: ReportStatus,
  extra?: { emailId?: string; approvedBy?: string; rejectReason?: string },
): Promise<LineReportRow | null> {
  const r = await pool.query<LineReportRow>(
    `UPDATE line_reports SET status=$3,
        approved_by   = COALESCE($4, approved_by),
        approved_at   = CASE WHEN $3 IN ('approved','sent') THEN now() ELSE approved_at END,
        sent_at       = CASE WHEN $3 = 'sent' THEN now() ELSE sent_at END,
        email_id      = COALESCE($5, email_id),
        reject_reason = COALESCE($6, reject_reason)
      WHERE tenant_id=$1 AND id=$2 RETURNING *`,
    [tenantId, id, status, extra?.approvedBy ?? null, extra?.emailId ?? null, extra?.rejectReason ?? null],
  );
  return r.rows[0] ?? null;
}
