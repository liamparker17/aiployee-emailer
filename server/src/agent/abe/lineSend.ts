import type pg from 'pg';
import { getDefaultSender } from '../../repos/senders.js';
import { getLineReportConfig } from '../../repos/lineReportConfigs.js';
import { getReport, setReportStatus, type LineReportRow } from '../../repos/lineReports.js';
import { queueEmail } from '../../send/pipeline.js';
import { claimForSend } from '../../repos/emails.js';
import { dispatchEmail } from '../../send/dispatch.js';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

  const report = await getReport(pool, tenantId, reportId);
  if (!report) return { ok: false, reason: 'not_found' };
  if (report.status !== 'pending_approval' && report.status !== 'approved') {
    return { ok: false, reason: 'not_approvable' };
  }

  const cfg = await getLineReportConfig(pool, tenantId);
  const recipients: string[] = cfg?.recipients ?? [];
  if (recipients.length === 0) return { ok: false, reason: 'no_recipients' };

  const sender = await getDefaultSender(pool, tenantId);
  if (!sender) return { ok: false, reason: 'no_default_sender' };

  const html = reportHtml(report.subject, report.body);
  let lastEmailId: string | null = null;

  for (const to of recipients) {
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
    const claimed = await claimForSend(pool, email.id);
    if (claimed) {
      await dispatchEmail({ pool, encKey, email: claimed, baseUrl });
    }
    lastEmailId = email.id;
  }

  const updated = await setReportStatus(pool, tenantId, reportId, 'sent', {
    emailId: lastEmailId ?? undefined,
    approvedBy,
  });
  return updated ? { ok: true, report: updated } : { ok: false, reason: 'update_failed' };
}
