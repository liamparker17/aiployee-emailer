import type pg from 'pg';
import { z } from 'zod';
import { AppError } from '@aiployee/core';
import { getSenderByEmail } from '../repos/senders.js';
import { getTemplateByName } from '../repos/templates.js';
import { isSuppressed } from '../repos/suppressions.js';
import { insertEmail, type EmailRow } from '../repos/emails.js';
import { render } from './render.js';

// Public API surface uses snake_case (matches spec, README, and external conventions: Stripe, Postmark, Mailgun).
// Base shape is exported separately so callers (e.g. v1Emails route) can .omit() before refine.
export const SendInputShape = z.object({
  tenantId: z.string().uuid(),
  from: z.string().email(),
  to: z.string().email(),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  reply_to: z.string().email().optional(),
  subject: z.string().min(1).optional(),
  html: z.string().min(1).optional(),
  text: z.string().optional(),
  template: z.string().optional(),
  variables: z.record(z.string(), z.string()).optional(),
  attachments: z.array(z.object({
    filename: z.string(),
    content: z.string(),       // base64
    content_type: z.string().optional(),
  })).optional(),
  scheduled_for: z.coerce.date().optional(),
  apiKeyId: z.string().uuid().optional(),
});

export const SendInput = SendInputShape.refine(
  (v) => (v.subject && v.html) || v.template,
  { message: 'Provide either subject+html or template' },
);

export type SendInputT = z.infer<typeof SendInput>;

export async function queueEmail(args: {
  pool: pg.Pool;
  enqueueSend: (emailId: string) => Promise<void>;
  input: SendInputT;
}): Promise<EmailRow> {
  const input = SendInput.parse(args.input);
  const sender = await getSenderByEmail(args.pool, input.tenantId, input.from);
  if (!sender) throw new AppError('invalid_sender', 400, `Sender not found: ${input.from}`);

  let subject = input.subject ?? '';
  let bodyHtml = input.html ?? '';
  let bodyText = input.text ?? null;
  let templateId: string | null = null;
  let fromDisplayName: string | null = null;

  if (input.template) {
    const tpl = await getTemplateByName(args.pool, input.tenantId, input.template);
    if (!tpl) throw new AppError('template_not_found', 404, `Template not found: ${input.template}`);
    templateId = tpl.id;
    fromDisplayName = tpl.display_name?.trim() || null;
    const vars = input.variables ?? {};
    try {
      subject = render(tpl.subject, vars, { escape: false });
      bodyHtml = render(tpl.body_html, vars);
      bodyText = tpl.body_text ? render(tpl.body_text, vars, { escape: false }) : null;
    } catch (e) {
      throw new AppError('render_failed', 400, (e as Error).message);
    }
  }

  if (await isSuppressed(args.pool, input.tenantId, input.to)) {
    return insertEmail(args.pool, {
      tenantId: input.tenantId, senderId: sender.id, toAddr: input.to,
      cc: input.cc, bcc: input.bcc, replyTo: input.reply_to ?? null,
      subject, bodyHtml, bodyText, templateId, attachments: input.attachments,
      status: 'suppressed', apiKeyId: input.apiKeyId ?? null, fromDisplayName,
    });
  }

  const email = await insertEmail(args.pool, {
    tenantId: input.tenantId, senderId: sender.id, toAddr: input.to,
    cc: input.cc, bcc: input.bcc, replyTo: input.reply_to ?? null,
    subject, bodyHtml, bodyText, templateId, attachments: input.attachments,
    scheduledFor: input.scheduled_for ?? null,
    status: 'queued', apiKeyId: input.apiKeyId ?? null, fromDisplayName,
  });

  if (!input.scheduled_for || input.scheduled_for.getTime() <= Date.now()) {
    await args.enqueueSend(email.id);
  }

  return email;
}
