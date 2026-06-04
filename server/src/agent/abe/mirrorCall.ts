import type pg from 'pg';
import { getLineReportConfig } from '../../repos/lineReportConfigs.js';

function stripHtml(html: string | null | undefined): string {
  return (html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Idempotent: one inbound call per email (message_ref = email id). Returns true if it created one.
export async function mirrorEmailAsCall(args: {
  pool: pg.Pool; tenantId: string; emailId: string; summary: string;
}): Promise<boolean> {
  const summary = (args.summary ?? '').trim();
  if (!summary) return false;
  const th = await args.pool.query<{ id: string }>(
    `INSERT INTO agent_threads (tenant_id, jobix_thread_ref) VALUES ($1, 'email-mirror')
       ON CONFLICT (tenant_id, jobix_thread_ref) DO UPDATE SET updated_at = now() RETURNING id`,
    [args.tenantId]);
  const r = await args.pool.query(
    `INSERT INTO agent_messages (thread_id, tenant_id, role, source, content, status, message_ref)
       VALUES ($1, $2, 'inbound', 'jobix', $3, 'sent', $4)
       ON CONFLICT (tenant_id, message_ref) WHERE message_ref IS NOT NULL DO NOTHING`,
    [th.rows[0].id, args.tenantId, summary, args.emailId]);
  return (r.rowCount ?? 0) > 0;
}

// Called from the send path: mirror only if the tenant opted in. Derives the summary.
export async function captureCallFromSend(args: {
  pool: pg.Pool; tenantId: string; emailId: string;
  summaryVar?: unknown; text?: string | null; html?: string | null; subject?: string | null;
}): Promise<boolean> {
  const cfg = await getLineReportConfig(args.pool, args.tenantId);
  if (!cfg?.ingest_sends_as_calls) return false;
  const summary =
    (typeof args.summaryVar === 'string' && args.summaryVar.trim()) ? args.summaryVar.trim()
    : (args.text && args.text.trim()) ? args.text.trim()
    : stripHtml(args.html) || (args.subject ?? '').trim();
  if (!summary) return false;
  return mirrorEmailAsCall({ pool: args.pool, tenantId: args.tenantId, emailId: args.emailId, summary });
}
