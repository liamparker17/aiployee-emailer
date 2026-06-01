import type pg from 'pg';
import { getDefaultSender } from '../../repos/senders.js';
import { queueEmail } from '../../send/pipeline.js';
import { claimForSend, type EmailRow } from '../../repos/emails.js';
import { dispatchEmail } from '../../send/dispatch.js';
import type { PlayRow } from '../../repos/agentPlays.js';
import { signApprovalToken, hashToken } from './approvalToken.js';
import { createApproval } from '../../repos/agentApprovals.js';

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Queue → claim → dispatch a single email via the tenant's default sender.
// Mirrors server/src/routes/v1Emails.ts. Returns the sent email id, or a reason if it could not send.
async function sendViaDefault(args: {
  pool: pg.Pool; encKey: Buffer; baseUrl: string;
  tenantId: string; to: string; subject: string; html: string;
}): Promise<{ sent: true; emailId: string } | { sent: false; reason: 'no_default_sender' }> {
  const sender = await getDefaultSender(args.pool, args.tenantId);
  if (!sender) return { sent: false, reason: 'no_default_sender' };

  const email: EmailRow = await queueEmail({
    pool: args.pool,
    enqueueSend: async () => {},
    input: {
      tenantId: args.tenantId,
      from: sender.email,
      reply_to: sender.email,
      to: args.to,
      subject: args.subject,
      html: args.html,
    },
  });
  const claimed = await claimForSend(args.pool, email.id);
  if (claimed) {
    await dispatchEmail({ pool: args.pool, encKey: args.encKey, email: claimed, baseUrl: args.baseUrl });
  }
  return { sent: true, emailId: email.id };
}

export interface SendApprovalResult {
  sent: boolean;
  reason?: 'no_default_sender';
  emailId?: string;
  token?: string;
}

// Builds the approval email (play summary + Approve/Reject/View links), creates the
// approval row, and sends. The caller (escalatePlay) guarantees a verified manager.
export async function sendApprovalEmail(args: {
  pool: pg.Pool; encKey: Buffer; baseUrl: string;
  tenantId: string; play: PlayRow; managerEmail: string;
}): Promise<SendApprovalResult> {
  const expiresMs = Date.now() + TOKEN_TTL_MS;
  const token = signApprovalToken(args.play.id, expiresMs, args.encKey);
  const base = `${args.baseUrl}/v1/agent/approve/${encodeURIComponent(token)}`;
  const approveUrl = `${base}?d=approve`;
  const rejectUrl = `${base}?d=reject`;
  const viewUrl = `${base}?d=view`;

  const audienceSize = args.play.audience_snapshot.size;
  const touchRows = args.play.touches
    .map((t) => `<li>Touch ${t.index + 1} (day ${t.scheduled_offset_days}): <strong>${escapeHtml(t.subject)}</strong></li>`)
    .join('');

  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#1a0f3d;max-width:560px;margin:0 auto;padding:24px">
<h2>Approval needed: re-engage campaign</h2>
<p>Abe wants to send a re-engagement campaign to <strong>${audienceSize}</strong> dormant contact(s).</p>
<ul>${touchRows}</ul>
<p style="margin:28px 0">
  <a href="${approveUrl}" style="background:#2e7d32;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;margin-right:8px">Approve</a>
  <a href="${rejectUrl}" style="background:#c62828;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;margin-right:8px">Reject</a>
  <a href="${viewUrl}" style="color:#1a0f3d">View details</a>
</p>
<p style="font-size:12px;color:#666">This link is single-use and expires in 7 days. You can also reply to this email.</p>
</body></html>`;

  const result = await sendViaDefault({
    pool: args.pool, encKey: args.encKey, baseUrl: args.baseUrl,
    tenantId: args.tenantId, to: args.managerEmail,
    subject: `Approve re-engage campaign (${audienceSize} contacts)?`,
    html,
  });
  if (!result.sent) return { sent: false, reason: result.reason };

  await createApproval({
    pool: args.pool,
    playId: args.play.id,
    tenantId: args.tenantId,
    tokenHash: hashToken(token),
    managerEmail: args.managerEmail,
    expiresAt: new Date(expiresMs),
  });

  return { sent: true, emailId: result.emailId, token };
}

export interface SendVerifyResult {
  sent: boolean;
  reason?: 'no_default_sender';
  emailId?: string;
  token?: string;
}

// Builds + sends the manager-verification email. The token encodes the tenantId
// (not a playId); the public verify route sets line_manager_verified_at.
export async function sendManagerVerifyEmail(args: {
  pool: pg.Pool; encKey: Buffer; baseUrl: string;
  tenantId: string; managerEmail: string;
}): Promise<SendVerifyResult> {
  const expiresMs = Date.now() + TOKEN_TTL_MS;
  const token = signApprovalToken(args.tenantId, expiresMs, args.encKey);
  const verifyUrl = `${args.baseUrl}/v1/agent/verify-manager/${encodeURIComponent(token)}`;

  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#1a0f3d;max-width:560px;margin:0 auto;padding:24px">
<h2>Confirm you'll approve campaigns</h2>
<p>You've been set as the approver for Abe's re-engagement campaigns. Confirm this email address so you can approve or reject campaigns.</p>
<p style="margin:28px 0">
  <a href="${verifyUrl}" style="background:#2e7d32;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Confirm this email</a>
</p>
<p style="font-size:12px;color:#666">This link expires in 7 days.</p>
</body></html>`;

  const result = await sendViaDefault({
    pool: args.pool, encKey: args.encKey, baseUrl: args.baseUrl,
    tenantId: args.tenantId, to: args.managerEmail,
    subject: 'Confirm your email to approve Abe campaigns',
    html,
  });
  if (!result.sent) return { sent: false, reason: result.reason };
  return { sent: true, emailId: result.emailId, token };
}
