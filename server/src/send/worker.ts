import type pg from 'pg';
import { logger } from '../util/logger.js';
import { claimForSend, markSent, markFailed } from '../repos/emails.js';
import { getSenderById } from '../repos/senders.js';
import { getSmtpConfigWithPassword } from '../repos/smtpConfigs.js';
import { buildTransport } from './sender.js';

export async function handleSendJob(args: {
  pool: pg.Pool;
  encKey: Buffer;
  emailId: string;
}): Promise<void> {
  const email = await claimForSend(args.pool, args.emailId);
  if (!email) {
    logger.info({ emailId: args.emailId }, 'send job skipped: not in queued/failed state');
    return;
  }
  try {
    const sender = await getSenderById(args.pool, email.tenant_id, email.sender_id);
    if (!sender) throw new Error(`sender ${email.sender_id} not found`);
    const cfg = await getSmtpConfigWithPassword(args.pool, args.encKey, email.tenant_id, sender.smtp_config_id);
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
        attachments: (email.attachments as Array<{ filename: string; content: string; contentType?: string }>).map(a => ({
          filename: a.filename, content: Buffer.from(a.content, 'base64'), contentType: a.contentType,
        })),
      });
      await markSent(args.pool, email.id, info.messageId);
    } finally { tx.close(); }
  } catch (e) {
    const msg = (e as Error).message;
    logger.warn({ emailId: email.id, err: msg }, 'send failed');
    await markFailed(args.pool, email.id, msg);
    throw e; // let pg-boss retry per its policy
  }
}
