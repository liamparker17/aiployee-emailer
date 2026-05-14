import type pg from 'pg';
import { logger } from '../util/logger.js';
import { markSent, markFailed, type EmailRow } from '../repos/emails.js';
import { getSenderById } from '../repos/senders.js';
import { getSmtpConfigWithPassword } from '../repos/smtpConfigs.js';
import { buildTransport } from './sender.js';

export type DispatchOutcome =
  | { ok: true; emailId: string; messageId: string }
  | { ok: false; emailId: string; error: string };

/** Send a single already-claimed email row through SMTP and persist the outcome. */
export async function dispatchEmail(args: {
  pool: pg.Pool;
  encKey: Buffer;
  email: EmailRow;
}): Promise<DispatchOutcome> {
  const { pool, encKey, email } = args;
  try {
    const sender = await getSenderById(pool, email.tenant_id, email.sender_id);
    if (!sender) throw new Error(`sender ${email.sender_id} not found`);
    const cfg = await getSmtpConfigWithPassword(pool, encKey, email.tenant_id, sender.smtp_config_id);
    if (!cfg) throw new Error(`smtp_config ${sender.smtp_config_id} not found`);
    const tx = buildTransport(cfg);
    try {
      const info = await tx.sendMail({
        from: { name: sender.display_name, address: sender.email },
        to: email.to_addr,
        cc: email.cc.length ? email.cc : undefined,
        bcc: email.bcc.length ? email.bcc : undefined,
        replyTo: email.reply_to ?? sender.reply_to ?? undefined,
        subject: email.subject,
        html: email.body_html,
        text: email.body_text ?? undefined,
        attachments: (email.attachments as Array<{ filename: string; content: string; content_type?: string }>).map(a => ({
          filename: a.filename, content: Buffer.from(a.content, 'base64'), contentType: a.content_type,
        })),
      });
      await markSent(pool, email.id, info.messageId);
      return { ok: true, emailId: email.id, messageId: info.messageId };
    } finally { tx.close(); }
  } catch (e) {
    const msg = (e as Error).message;
    logger.warn({ emailId: email.id, err: msg }, 'send failed');
    await markFailed(pool, email.id, msg);
    return { ok: false, emailId: email.id, error: msg };
  }
}
