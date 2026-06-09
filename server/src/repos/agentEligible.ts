import type pg from 'pg';
import type { ContactRow } from './contacts.js';

/** From `contactIds`, the contacts still subscribed, not suppressed, and (if reengagedSince set) with
 *  no open/click at/after that time. Pass reengagedSince=null to apply only suppression/subscription. */
export async function findEligibleContacts(
  pool: pg.Pool,
  tenantId: string,
  contactIds: string[],
  reengagedSince: Date | null,
): Promise<ContactRow[]> {
  if (contactIds.length === 0) return [];
  const r = await pool.query<ContactRow>(
    `SELECT c.*
       FROM contacts c
      WHERE c.tenant_id = $1
        AND c.id = ANY($2::uuid[])
        AND c.subscribed = true
        AND NOT EXISTS (
              SELECT 1 FROM suppressions s
               WHERE s.tenant_id = c.tenant_id AND lower(s.address) = lower(c.email))
        AND ($3::timestamptz IS NULL OR NOT EXISTS (
              SELECT 1 FROM email_events ev
                JOIN emails e ON e.id = ev.email_id
               WHERE e.tenant_id = c.tenant_id
                 AND lower(e.to_addr) = lower(c.email)
                 AND ev.type IN ('open','click')
                 AND ev.created_at >= $3))
      ORDER BY c.created_at ASC`,
    [tenantId, contactIds, reengagedSince],
  );
  return r.rows;
}
