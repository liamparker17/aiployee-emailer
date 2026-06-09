import type pg from 'pg';
import type { ContactRow } from '@aiployee/core';

/** Contacts with no open/click engagement within `windowDays`, excluding suppressed and too-new contacts. */
export async function findDormantContacts(
  pool: pg.Pool,
  tenantId: string,
  windowDays: number,
): Promise<ContactRow[]> {
  const r = await pool.query<ContactRow>(
    `SELECT c.*
       FROM contacts c
      WHERE c.tenant_id = $1
        AND c.subscribed = true
        AND c.created_at < now() - make_interval(days => $2::int)
        AND NOT EXISTS (
              SELECT 1 FROM suppressions s
               WHERE s.tenant_id = c.tenant_id
                 AND lower(s.address) = lower(c.email))
        AND NOT EXISTS (
              SELECT 1
                FROM email_events ev
                JOIN emails e ON e.id = ev.email_id
               WHERE e.tenant_id = c.tenant_id
                 AND lower(e.to_addr) = lower(c.email)
                 AND ev.type IN ('open','click')
                 AND ev.created_at >= now() - make_interval(days => $2::int))
      ORDER BY c.created_at ASC`,
    [tenantId, windowDays],
  );
  return r.rows;
}
