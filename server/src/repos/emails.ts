import type pg from 'pg';

export type EmailStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'bounced' | 'complained' | 'suppressed' | 'canceled';

export interface EmailRow {
  id: string; tenant_id: string; sender_id: string;
  to_addr: string; cc: string[]; bcc: string[]; reply_to: string | null;
  subject: string; body_html: string; body_text: string | null;
  template_id: string | null; attachments: unknown[];
  status: EmailStatus; scheduled_for: Date | null; sent_at: Date | null;
  error: string | null; message_id: string | null; api_key_id: string | null;
  created_at: Date;
}

const SELECT = `
  id, tenant_id, sender_id, to_addr, cc, bcc, reply_to,
  subject, body_html, body_text, template_id, attachments, status,
  scheduled_for, sent_at, error, message_id, api_key_id, created_at`;

export async function insertEmail(pool: pg.Pool, input: {
  tenantId: string; senderId: string; toAddr: string; cc?: string[]; bcc?: string[];
  replyTo?: string | null; subject: string; bodyHtml: string; bodyText?: string | null;
  templateId?: string | null; attachments?: unknown[]; scheduledFor?: Date | null;
  apiKeyId?: string | null; status?: EmailStatus; campaignId?: string | null;
}): Promise<EmailRow> {
  const r = await pool.query<EmailRow>(
    `INSERT INTO emails(tenant_id, sender_id, to_addr, cc, bcc, reply_to,
                         subject, body_html, body_text, template_id, attachments,
                         status, scheduled_for, api_key_id, campaign_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15)
     RETURNING ${SELECT}`,
    [
      input.tenantId, input.senderId, input.toAddr,
      input.cc ?? [], input.bcc ?? [], input.replyTo ?? null,
      input.subject, input.bodyHtml, input.bodyText ?? null,
      input.templateId ?? null, JSON.stringify(input.attachments ?? []),
      input.status ?? 'queued', input.scheduledFor ?? null, input.apiKeyId ?? null,
      input.campaignId ?? null,
    ],
  );
  return r.rows[0];
}

export async function getEmail(pool: pg.Pool, tenantId: string, id: string): Promise<EmailRow | null> {
  const r = await pool.query<EmailRow>(
    `SELECT ${SELECT} FROM emails WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return r.rows[0] ?? null;
}

export interface EmailListRow extends EmailRow { open_count: number; click_count: number }

export async function listEmails(pool: pg.Pool, tenantId: string, opts: {
  status?: EmailStatus; since?: Date; limit?: number;
} = {}): Promise<EmailListRow[]> {
  const where = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  if (opts.status) { params.push(opts.status); where.push(`status = $${params.length}`); }
  if (opts.since) { params.push(opts.since); where.push(`created_at >= $${params.length}`); }
  params.push(Math.min(opts.limit ?? 100, 500));
  const r = await pool.query<EmailListRow>(
    `SELECT ${SELECT},
       (SELECT count(*)::int FROM email_events ev WHERE ev.email_id = emails.id AND ev.type = 'open') AS open_count,
       (SELECT count(*)::int FROM email_events ev WHERE ev.email_id = emails.id AND ev.type = 'click') AS click_count
     FROM emails WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC LIMIT $${params.length}`, params);
  return r.rows;
}

/** Cancel a scheduled (still-queued) email. Returns true only if it was queued. */
export async function cancelScheduledEmail(pool: pg.Pool, tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE emails SET status = 'canceled' WHERE tenant_id = $1 AND id = $2 AND status = 'queued'`,
    [tenantId, id]);
  return r.rowCount === 1;
}

export async function claimForSend(pool: pg.Pool, id: string): Promise<EmailRow | null> {
  const r = await pool.query<EmailRow>(
    `UPDATE emails SET status = 'sending'
     WHERE id = $1 AND status IN ('queued','failed') RETURNING ${SELECT}`, [id]);
  return r.rows[0] ?? null;
}

export async function markSent(pool: pg.Pool, id: string, messageId: string): Promise<void> {
  await pool.query(
    `UPDATE emails SET status='sent', sent_at = now(), message_id = $2, error = NULL WHERE id = $1`,
    [id, messageId]);
}

export async function markFailed(pool: pg.Pool, id: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE emails SET status='failed', error = $2, retry_count = retry_count + 1 WHERE id = $1`,
    [id, error]);
}

/** Atomically claim up to `limit` due emails. Sets status='sending' so concurrent cron invocations don't double-send. */
export async function claimDueForSend(pool: pg.Pool, limit = 50): Promise<EmailRow[]> {
  const r = await pool.query<EmailRow>(
    `UPDATE emails SET status = 'sending'
     WHERE id IN (
       SELECT id FROM emails
       WHERE status = 'queued'
         AND (scheduled_for IS NULL OR scheduled_for <= now())
       ORDER BY scheduled_for NULLS FIRST, created_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING ${SELECT}`,
    [limit]);
  return r.rows;
}

/**
 * Move failed-or-stuck emails back to queued so the next cron tick retries them.
 * - 'failed' rows: requeued if retry_count < maxAttempts and they've cooled off.
 * - 'sending' rows: requeued if they've been stuck longer than stuckSeconds (covers
 *   the case where a function crashed after claiming but before marking sent/failed).
 */
export async function requeueFailedAndStuck(pool: pg.Pool, opts: {
  maxAttempts?: number;
  cooloffSeconds?: number;
  stuckSeconds?: number;
} = {}): Promise<{ failed: number; stuck: number }> {
  const max = opts.maxAttempts ?? 2;          // initial attempt + 1 retry by default
  const cool = opts.cooloffSeconds ?? 60;
  const stuck = opts.stuckSeconds ?? 120;     // 2 min — well past inline-send timeout

  const failed = await pool.query(
    `UPDATE emails SET status='queued'
     WHERE status='failed' AND retry_count < $1 AND updated_at < now() - ($2 || ' seconds')::interval`,
    [max, String(cool)]);

  const stuckRows = await pool.query(
    `UPDATE emails SET status='queued'
     WHERE status='sending' AND updated_at < now() - ($1 || ' seconds')::interval`,
    [String(stuck)]);

  return { failed: failed.rowCount ?? 0, stuck: stuckRows.rowCount ?? 0 };
}

export async function markStatus(pool: pg.Pool, id: string, status: EmailStatus): Promise<void> {
  await pool.query(`UPDATE emails SET status = $2 WHERE id = $1`, [id, status]);
}

export async function findByMessageId(pool: pg.Pool, messageId: string): Promise<EmailRow | null> {
  const r = await pool.query<EmailRow>(
    `SELECT ${SELECT} FROM emails WHERE message_id = $1 LIMIT 1`, [messageId]);
  return r.rows[0] ?? null;
}
