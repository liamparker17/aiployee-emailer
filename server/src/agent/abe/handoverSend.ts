import type pg from 'pg';
import { getDefaultSender } from '@aiployee/core';
import { getLineReportConfig } from '../../repos/lineReportConfigs.js';
import { clientLabel } from './clientContext.js';
import { getHandover, setHandoverStatus, type HandoverRow } from '../../repos/callHandovers.js';
import { queueEmail } from '@aiployee/core';
import { claimForSend } from '@aiployee/core';
import { dispatchEmail } from '@aiployee/core';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function handoverHtml(h: HandoverRow, clientName: string): { subject: string; html: string } {
  const subject = `Callback for ${clientName} — ${h.caller_name ?? 'caller'} · ${h.reason_category}${h.urgency === 'high' ? ' · URGENT' : ''}`;
  const row = (k: string, v: string | null) =>
    `<tr><td style="padding:2px 12px 2px 0;color:#555">${esc(k)}</td><td>${v ? esc(v) : '<em>— not captured —</em>'}</td></tr>`;
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#1a0f3d;max-width:640px;margin:0 auto;padding:24px">
    <h2>${esc(subject)}</h2>
    <table style="font-size:14px;border-collapse:collapse">
    ${row('Caller', h.caller_name)}${row('Phone', h.caller_phone)}${row('Account', h.account_ref)}
    ${row('Reason', h.reason_category)}${row('Urgency', h.urgency)}${h.vulnerable ? row('Flag', 'Vulnerable / at-risk caller') : ''}</table>
    <p style="white-space:pre-wrap;margin-top:12px">${esc(h.summary)}</p>
    ${h.recommended_action ? `<p><strong>Recommended action:</strong> ${esc(h.recommended_action)}</p>` : ''}
    ${h.missing_fields.length ? `<p style="color:#a00"><strong>Note:</strong> missing details — ${h.missing_fields.map(esc).join(', ')}.</p>` : ''}
  </body></html>`;
  return { subject, html };
}

export async function forwardHandover(args: {
  pool: pg.Pool;
  encKey: Buffer;
  baseUrl: string;
  tenantId: string;
  handoverId: string;
  approvedBy: string;
}): Promise<{ ok: true; handover: HandoverRow } | { ok: false; reason: string }> {
  const { pool, encKey, baseUrl, tenantId, handoverId, approvedBy } = args;

  // Read-only pre-checks (so a fixable config problem leaves the handover still pending)
  const h0 = await getHandover(pool, tenantId, handoverId);
  if (!h0) return { ok: false, reason: 'not_found' };
  if (h0.status !== 'pending') return { ok: false, reason: 'not_forwardable' };

  const cfg = await getLineReportConfig(pool, tenantId);
  const recipients = cfg?.recipients ?? [];
  if (recipients.length === 0) return { ok: false, reason: 'no_recipients' };

  const sender = await getDefaultSender(pool, tenantId);
  if (!sender) return { ok: false, reason: 'no_default_sender' };

  // Atomic claim: only one caller can transition pending -> forwarded.
  // rowCount === 0 means a race or already forwarded — abort without sending.
  const claim = await pool.query(
    `UPDATE call_handovers SET status='forwarded', approved_by=$3, forwarded_at=now()
       WHERE tenant_id=$1 AND id=$2 AND status='pending' RETURNING id`,
    [tenantId, handoverId, approvedBy],
  );
  if (claim.rowCount === 0) return { ok: false, reason: 'not_forwardable' };

  const { subject, html } = handoverHtml(h0, clientLabel(cfg));
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
          subject,
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

  const updated = await setHandoverStatus(pool, tenantId, handoverId, 'forwarded', {
    emailId: emailIds[0] ?? undefined,
    approvedBy,
  });
  return updated ? { ok: true, handover: updated } : { ok: false, reason: 'update_failed' };
}
