import type pg from 'pg';
import { getDefaultSender } from '@aiployee/core';
import { getLineReportConfig } from '../../repos/lineReportConfigs.js';
import { getReport, setReportStatus, type LineReportRow } from '../../repos/lineReports.js';
import { queueEmail } from '@aiployee/core';
import { claimForSend } from '@aiployee/core';
import { dispatchEmail } from '@aiployee/core';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function reportHtml(subject: string, body: string): string {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#1a0f3d;max-width:680px;margin:0 auto;padding:24px">
<h2>${escapeHtml(subject)}</h2>
<div style="white-space:pre-wrap">${escapeHtml(body)}</div>
</body></html>`;
}

export async function approveAndSendReport(args: {
  pool: pg.Pool;
  encKey: Buffer;
  baseUrl: string;
  tenantId: string;
  reportId: string;
  approvedBy: string;
}): Promise<{ ok: true; report: LineReportRow } | { ok: false; reason: string }> {
  const { pool, encKey, baseUrl, tenantId, reportId, approvedBy } = args;

  // Read-only pre-checks first, so a fixable config problem leaves the report
  // still pending_approval (re-approvable after the operator fixes it).
  const report = await getReport(pool, tenantId, reportId);
  if (!report) return { ok: false, reason: 'not_found' };
  if (report.status !== 'pending_approval') return { ok: false, reason: 'not_approvable' };

  const cfg = await getLineReportConfig(pool, tenantId);
  const recipients: string[] = cfg?.recipients ?? [];
  if (recipients.length === 0) return { ok: false, reason: 'no_recipients' };

  const sender = await getDefaultSender(pool, tenantId);
  if (!sender) return { ok: false, reason: 'no_default_sender' };

  // Atomic claim: only one caller can transition pending_approval -> approved.
  // A re-approve or a concurrent race gets rowCount 0 and sends nothing — this
  // is the guard against double-sending to the client.
  const claim = await pool.query(
    `UPDATE line_reports SET status='approved', approved_by=$3, approved_at=now()
       WHERE tenant_id=$1 AND id=$2 AND status='pending_approval' RETURNING id`,
    [tenantId, reportId, approvedBy],
  );
  if (claim.rowCount === 0) return { ok: false, reason: 'not_approvable' };

  // We now exclusively own this report; send to each recipient. One recipient's
  // failure must not abort the rest.
  const html = reportHtml(report.subject, report.body);
  const emailIds: string[] = [];
  for (const to of recipients) {
    try {
      const email = await queueEmail({
        pool,
        enqueueSend: async () => {},
        input: {
          tenantId,
          from: sender.email,
          reply_to: sender.email,
          to,
          subject: report.subject,
          html,
        },
      });
      emailIds.push(email.id);
      const claimed = await claimForSend(pool, email.id);
      if (claimed) {
        await dispatchEmail({ pool, encKey, email: claimed, baseUrl });
      }
    } catch {
      // best-effort per recipient; continue sending to the others
    }
  }

  const updated = await setReportStatus(pool, tenantId, reportId, 'sent', {
    emailId: emailIds[0] ?? undefined,
    approvedBy,
  });
  return updated ? { ok: true, report: updated } : { ok: false, reason: 'update_failed' };
}
