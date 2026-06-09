import type pg from 'pg';

export interface CorrelationInput {
  fromAddr: string;
  subject: string | null;
  inReplyTo: string | null;
  references: string | null;
}

export interface Correlation {
  emailId: string | null;
  campaignId: string | null;
  contactId: string | null;
}

function refMessageIds(input: CorrelationInput): string[] {
  const ids: string[] = [];
  if (input.inReplyTo) ids.push(input.inReplyTo.trim());
  if (input.references) for (const r of input.references.split(/\s+/)) if (r) ids.push(r.trim());
  return [...new Set(ids)];
}

function isReplySubject(subject: string | null): boolean {
  return !!subject && /^\s*re\s*:/i.test(subject);
}

async function contactIdForEmail(pool: pg.Pool, tenantId: string, addr: string): Promise<string | null> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM contacts WHERE tenant_id = $1 AND lower(email) = lower($2) LIMIT 1`,
    [tenantId, addr],
  );
  return r.rows[0]?.id ?? null;
}

export async function correlateReply(
  pool: pg.Pool, tenantId: string, input: CorrelationInput,
): Promise<Correlation> {
  // 1. Exact: a referenced message-id matches a sent email.
  const ids = refMessageIds(input);
  if (ids.length) {
    const r = await pool.query<{ id: string; campaign_id: string | null; to_addr: string }>(
      `SELECT id, campaign_id, to_addr FROM emails
       WHERE tenant_id = $1 AND message_id = ANY($2::text[])
       ORDER BY sent_at DESC NULLS LAST LIMIT 1`,
      [tenantId, ids],
    );
    const hit = r.rows[0];
    if (hit) {
      const contactId = await contactIdForEmail(pool, tenantId, hit.to_addr);
      return { emailId: hit.id, campaignId: hit.campaign_id, contactId };
    }
  }

  // 2. Fallback: known contact + Re: subject → most recent campaign send in 30 days.
  if (isReplySubject(input.subject)) {
    const contactId = await contactIdForEmail(pool, tenantId, input.fromAddr);
    if (contactId) {
      const r = await pool.query<{ campaign_id: string | null }>(
        `SELECT campaign_id FROM emails
         WHERE tenant_id = $1 AND lower(to_addr) = lower($2)
           AND campaign_id IS NOT NULL
           AND sent_at >= now() - interval '30 days'
         ORDER BY sent_at DESC LIMIT 1`,
        [tenantId, input.fromAddr],
      );
      return { emailId: null, campaignId: r.rows[0]?.campaign_id ?? null, contactId };
    }
  }

  // 3. None.
  return { emailId: null, campaignId: null, contactId: null };
}
