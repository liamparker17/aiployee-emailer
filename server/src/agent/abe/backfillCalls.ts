import type pg from 'pg';
import { mirrorEmailAsCall } from './mirrorCall.js';
import { tagNewCalls } from './lineTagger.js';
import { ensureCategories } from './setupCategories.js';

interface LlmLike {
  chat(a: { model: string; messages: Array<{ role: string; content: string }> }): Promise<{ content: string }>;
}

const stripHtml = (h: string | null): string =>
  (h ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// Backfill: turn a tenant's already-sent emails into inbound calls, then tag
// the newly-mirrored calls. Idempotent — re-running imports nothing new because
// mirrorEmailAsCall keys on message_ref = email.id (see NOT EXISTS below).
export async function backfillCallsFromEmails(args: {
  pool: pg.Pool; tenantId: string; llm: LlmLike; model: string; cap?: number;
}): Promise<{ imported: number; tagged: number }> {
  const cap = args.cap ?? 1000;

  const emails = await args.pool.query<{
    id: string; subject: string; body_text: string | null; body_html: string | null;
  }>(
    `SELECT e.id, e.subject, e.body_text, e.body_html FROM emails e
      WHERE e.tenant_id = $1 AND e.status = 'sent'
        AND NOT EXISTS (
          SELECT 1 FROM agent_messages m
           WHERE m.tenant_id = $1 AND m.message_ref = e.id::text)
      ORDER BY e.created_at DESC LIMIT $2`,
    [args.tenantId, cap]);

  let imported = 0;
  for (const e of emails.rows) {
    const summary =
      (e.body_text && e.body_text.trim()) || stripHtml(e.body_html) || (e.subject ?? '').trim();
    if (await mirrorEmailAsCall({ pool: args.pool, tenantId: args.tenantId, emailId: e.id, summary })) {
      imported++;
    }
  }

  await ensureCategories({ pool: args.pool, tenantId: args.tenantId, llm: args.llm, model: args.model });
  await backfillCallFactsForTenant(args.pool, args.tenantId);

  let tagged = 0;
  while (tagged < cap) {
    const n = await tagNewCalls({
      pool: args.pool, tenantId: args.tenantId, llm: args.llm, model: args.model, batch: 50,
    });
    if (n === 0) break;
    tagged += n;
  }

  return { imported, tagged };
}

// Give every inbound jobix message a call_facts row (summary = content, structured fields null).
// For legacy/mirror calls that predate the webhook. Idempotent via the unique(message_id).
export async function backfillCallFactsForTenant(pool: pg.Pool, tenantId: string): Promise<number> {
  const r = await pool.query(
    `INSERT INTO call_facts (tenant_id, message_id, summary)
       SELECT m.tenant_id, m.id, m.content
         FROM agent_messages m
         LEFT JOIN call_facts f ON f.message_id = m.id
        WHERE m.tenant_id = $1 AND m.role = 'inbound' AND m.source = 'jobix' AND f.id IS NULL
     ON CONFLICT (message_id) DO NOTHING`,
    [tenantId]);
  return r.rowCount ?? 0;
}
