// Branded emails for the emailed M365 connection link. Table + inline styles (Outlook-safe);
// every dynamic value goes through esc(). Palette/shell ported from feat/microsoft-invite-connect.

export const esc = (s: unknown) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function shell(inner: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f5fb;padding:24px 0">
<tr><td align="center"><table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #e6e3f1;border-radius:12px">
<tr><td style="padding:20px 24px;border-bottom:1px solid #e6e3f1;font:600 18px Arial,sans-serif;color:#1a1530"><span style="display:inline-block;width:36px;height:36px;border-radius:8px;background:#1a0f3d;color:#d146ff;font:700 18px/36px Arial,sans-serif;text-align:center;vertical-align:middle">A</span>&nbsp; Aiployee</td></tr>
<tr><td style="padding:24px;font:15px/1.55 Arial,sans-serif;color:#1a1530">${inner}</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #e6e3f1;font:12px/1.5 Arial,sans-serif;color:#5d5873">
If you weren't expecting this email you can ignore it. Nothing happens unless you sign in and approve.</td></tr>
</table></td></tr></table>`;
}

const button = (href: string, label: string) =>
  `<p style="margin:20px 0"><a href="${esc(href)}" style="display:inline-block;background:#5b3df5;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">${esc(label)}</a></p>`;

export interface Mail { subject: string; html: string; text: string }

export function inviteEmail(v: { mailbox: string; inviter: string | null; company: string; url: string; shared: boolean }): Mail {
  const who = v.inviter ? `${esc(v.inviter)} (${esc(v.company)})` : esc(v.company);
  const sharedNote = v.shared
    ? `<p><strong>Shared mailbox:</strong> you can sign in with your own Microsoft account, as long as it has "Send As" permission on ${esc(v.mailbox)}.</p>`
    : '';
  const html = shell(`<p>${who} would like Aiployee to send email from <strong>${esc(v.mailbox)}</strong>.</p>
<p>It takes about a minute: you will get a short code, enter it on Microsoft's own sign-in page, and click Accept.</p>
${sharedNote}${button(v.url, 'Connect your mailbox')}
<p style="color:#5d5873;font-size:13px">The link works once and expires in 72 hours.</p>
<hr style="border:0;border-top:1px solid #e6e3f1;margin:20px 0">
<p><strong>What this allows:</strong> Aiployee can <em>send</em> emails (for example call summaries and follow-ups) from ${esc(v.mailbox)}, so replies come straight back to that mailbox.</p>
<p><strong>What it does not allow:</strong> it cannot read, search, move or delete anything in the mailbox, and Aiployee never sees your password. You can remove access at any time at myapplications.microsoft.com.</p>`);
  const text = `${v.inviter ? `${v.inviter} (${v.company})` : v.company} would like Aiployee to send email from ${v.mailbox}.

Connect your mailbox: ${v.url}

It takes about a minute: you get a short code, enter it on Microsoft's sign-in page, and click Accept. The link works once and expires in 72 hours.
${v.shared ? `\nShared mailbox: sign in with your own Microsoft account if it has "Send As" permission on ${v.mailbox}.\n` : ''}
Aiployee can only SEND mail from this address. It cannot read, search, move or delete anything, and never sees your password. Remove access any time at myapplications.microsoft.com.`;
  return { subject: `Connect ${v.mailbox} to send email with Aiployee`, html, text };
}

const REASONS: Record<string, string> = {
  declined: 'The sign-in was declined.',
  mismatch: 'A different Microsoft account signed in than the one expected, so nothing was connected.',
  error: 'Microsoft sign-in did not complete.',
  too_many_attempts: 'Too many attempts were made on this link.',
};

export function adminNoticeEmail(v: { mailbox: string; ok: boolean; reason?: string; signedInAs?: string }): Mail {
  if (v.ok) {
    const sub = `Connected: ${v.mailbox}`;
    return {
      subject: sub,
      html: shell(`<p><strong>${esc(v.mailbox)}</strong> is now connected as a sender.${v.signedInAs && v.signedInAs.toLowerCase() !== v.mailbox.toLowerCase() ? ` It was authorised by ${esc(v.signedInAs)}.` : ''}</p>`),
      text: `${v.mailbox} is now connected as a sender.${v.signedInAs && v.signedInAs.toLowerCase() !== v.mailbox.toLowerCase() ? ` Authorised by ${v.signedInAs}.` : ''}`,
    };
  }
  const why = REASONS[v.reason ?? 'error'] ?? REASONS.error;
  const extra = v.reason === 'mismatch' && v.signedInAs ? ` (signed in as ${v.signedInAs})` : '';
  return {
    subject: `Connection problem: ${v.mailbox}`,
    html: shell(`<p>Connecting <strong>${esc(v.mailbox)}</strong> did not complete.</p><p>${esc(why)}${esc(extra)}</p>`),
    text: `Connecting ${v.mailbox} did not complete. ${why}${extra}`,
  };
}
