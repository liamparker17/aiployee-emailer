import type pg from 'pg';
import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPPool from 'nodemailer/lib/smtp-pool/index.js';
import { logger } from '@aiployee/core';
import { markSent, markFailed, type EmailRow } from '../repos/emails.js';
import { getSenderById, type Sender } from '../repos/senders.js';
import { getSmtpConfigWithPassword, type SmtpConfigRow } from '../repos/smtpConfigs.js';
import { deliverEmailEvent } from '../webhooks/eventDelivery.js';
import { injectTracking } from './tracking.js';

/** Best-effort: notify tenant event webhooks that an email was sent. Never throws. */
async function fireSent(pool: pg.Pool, encKey: Buffer, email: EmailRow): Promise<void> {
  await deliverEmailEvent({
    pool, encKey, tenantId: email.tenant_id, event: 'sent',
    payload: { email_id: email.id, to: email.to_addr, subject: email.subject },
  });
}

export type DispatchOutcome =
  | { ok: true; emailId: string; messageId: string }
  | { ok: false; emailId: string; error: string };

function buildPooledTransport(cfg: SmtpConfigRow & { password: string }): Transporter {
  // Pooled transport reuses TCP+TLS across many sends — the single biggest throughput win
  // when many emails share an SMTP config.
  const opts: SMTPPool.Options = {
    pool: true,
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.username, pass: cfg.password },
    maxConnections: 5,
    maxMessages: 100,
  };
  return nodemailer.createTransport(opts);
}

async function sendOne(
  pool: pg.Pool,
  tx: Transporter,
  sender: Sender,
  email: EmailRow,
  baseUrl: string,
): Promise<DispatchOutcome> {
  try {
    const info = await tx.sendMail({
      from: { name: email.from_display_name ?? sender.display_name, address: sender.email },
      to: email.to_addr,
      cc: email.cc.length ? email.cc : undefined,
      bcc: email.bcc.length ? email.bcc : undefined,
      replyTo: email.reply_to ?? sender.reply_to ?? undefined,
      subject: email.subject,
      html: injectTracking(email.body_html, { emailId: email.id, baseUrl }),
      text: email.body_text ?? undefined,
      // Attachments are stored either inline as base64 (the /v1/emails API) or as a Vercel
      // Blob URL (campaign attachments uploaded from the browser). nodemailer fetches `path`
      // URLs itself, so large files never pass through our function's request body.
      attachments: (email.attachments as Array<{ filename: string; content?: string; url?: string; content_type?: string }>).map(a =>
        a.content != null
          ? { filename: a.filename, content: Buffer.from(a.content, 'base64'), contentType: a.content_type }
          : { filename: a.filename, path: a.url, contentType: a.content_type },
      ),
      headers: email.list_unsubscribe
        ? { 'List-Unsubscribe': `<${email.list_unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
        : undefined,
    });
    await markSent(pool, email.id, info.messageId);
    return { ok: true, emailId: email.id, messageId: info.messageId };
  } catch (e) {
    const msg = (e as Error).message;
    logger.warn({ emailId: email.id, err: msg }, 'send failed');
    await markFailed(pool, email.id, msg);
    return { ok: false, emailId: email.id, error: msg };
  }
}

/** Dispatch a single already-claimed email. Used by inline POST /v1/emails. */
export async function dispatchEmail(args: {
  pool: pg.Pool;
  encKey: Buffer;
  email: EmailRow;
  baseUrl: string;
}): Promise<DispatchOutcome> {
  const { pool, encKey, email, baseUrl } = args;
  try {
    const sender = await getSenderById(pool, email.tenant_id, email.sender_id);
    if (!sender) throw new Error(`sender ${email.sender_id} not found`);
    const cfg = await getSmtpConfigWithPassword(pool, encKey, email.tenant_id, sender.smtp_config_id);
    if (!cfg) throw new Error(`smtp_config ${sender.smtp_config_id} not found`);
    const tx = buildPooledTransport(cfg);
    let outcome: DispatchOutcome;
    try { outcome = await sendOne(pool, tx, sender, email, baseUrl); }
    finally { tx.close(); }
    if (outcome.ok) await fireSent(pool, encKey, email);
    return outcome;
  } catch (e) {
    const msg = (e as Error).message;
    await markFailed(pool, email.id, msg);
    return { ok: false, emailId: email.id, error: msg };
  }
}

/**
 * Batch-dispatch many already-claimed emails. Groups by smtp_config_id so each
 * provider gets ONE pooled transport handling all its emails — TCP+TLS handshake
 * happens once per provider per tick, not once per email.
 */
export async function dispatchBatch(args: {
  pool: pg.Pool;
  encKey: Buffer;
  emails: EmailRow[];
  baseUrl: string;
}): Promise<DispatchOutcome[]> {
  const { pool, encKey, emails, baseUrl } = args;
  if (emails.length === 0) return [];

  // Look up all senders + configs in parallel up-front
  const senders = new Map<string, Sender>();
  const configs = new Map<string, SmtpConfigRow & { password: string }>();
  await Promise.all(emails.map(async (e) => {
    if (!senders.has(e.sender_id)) {
      const s = await getSenderById(pool, e.tenant_id, e.sender_id);
      if (s) senders.set(e.sender_id, s);
    }
  }));
  const configIds = new Set([...senders.values()].map(s => s.smtp_config_id));
  await Promise.all([...configIds].map(async (id) => {
    const sender = [...senders.values()].find(s => s.smtp_config_id === id)!;
    const cfg = await getSmtpConfigWithPassword(pool, encKey, sender.tenant_id, id);
    if (cfg) configs.set(id, cfg);
  }));

  // Group emails by smtp_config_id (resolved via sender)
  const groups = new Map<string, EmailRow[]>();
  const orphans: EmailRow[] = [];
  for (const e of emails) {
    const sender = senders.get(e.sender_id);
    if (!sender) { orphans.push(e); continue; }
    const arr = groups.get(sender.smtp_config_id) ?? [];
    arr.push(e);
    groups.set(sender.smtp_config_id, arr);
  }

  // Build one pooled transport per group; send all that group's emails in parallel through it
  const groupResults = await Promise.all([...groups.entries()].map(async ([cfgId, groupEmails]) => {
    const cfg = configs.get(cfgId);
    if (!cfg) {
      return Promise.all(groupEmails.map(async (e): Promise<DispatchOutcome> => {
        await markFailed(pool, e.id, `smtp_config ${cfgId} not found`);
        return { ok: false, emailId: e.id, error: `smtp_config ${cfgId} not found` };
      }));
    }
    const tx = buildPooledTransport(cfg);
    try {
      return await Promise.all(groupEmails.map(async e => {
        const sender = senders.get(e.sender_id)!;
        const out = await sendOne(pool, tx, sender, e, baseUrl);
        if (out.ok) await fireSent(pool, encKey, e);
        return out;
      }));
    } finally { tx.close(); }
  }));

  const orphanResults = await Promise.all(orphans.map(async (e): Promise<DispatchOutcome> => {
    await markFailed(pool, e.id, `sender ${e.sender_id} not found`);
    return { ok: false, emailId: e.id, error: `sender ${e.sender_id} not found` };
  }));

  return [...groupResults.flat(), ...orphanResults];
}
