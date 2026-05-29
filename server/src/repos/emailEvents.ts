import type pg from 'pg';

// INSERT ... SELECT FROM emails: records the event only if the email exists, and
// pulls tenant_id from it (so trackers never need to be trusted with a tenant).
export async function recordOpen(pool: pg.Pool, emailId: string): Promise<void> {
  await pool.query(
    `INSERT INTO email_events (email_id, tenant_id, type)
     SELECT id, tenant_id, 'open' FROM emails WHERE id = $1`, [emailId]);
}

export async function recordClick(pool: pg.Pool, emailId: string, url: string): Promise<void> {
  await pool.query(
    `INSERT INTO email_events (email_id, tenant_id, type, url)
     SELECT id, tenant_id, 'click', $2 FROM emails WHERE id = $1`, [emailId, url]);
}

export interface EngagementSummary {
  sent: number; opens: number; uniqueOpens: number; clicks: number; uniqueClicks: number; bounced: number;
}

export async function engagementSummary(pool: pg.Pool, tenantId: string): Promise<EngagementSummary> {
  const r = await pool.query<{ sent: number; opens: number; unique_opens: number; clicks: number; unique_clicks: number; bounced: number }>(
    `SELECT
       (SELECT count(*)::int FROM emails WHERE tenant_id = $1 AND status IN ('sent','delivered')) AS sent,
       (SELECT count(*)::int FROM email_events WHERE tenant_id = $1 AND type = 'open') AS opens,
       (SELECT count(DISTINCT email_id)::int FROM email_events WHERE tenant_id = $1 AND type = 'open') AS unique_opens,
       (SELECT count(*)::int FROM email_events WHERE tenant_id = $1 AND type = 'click') AS clicks,
       (SELECT count(DISTINCT email_id)::int FROM email_events WHERE tenant_id = $1 AND type = 'click') AS unique_clicks,
       (SELECT count(*)::int FROM emails WHERE tenant_id = $1 AND status = 'bounced') AS bounced`,
    [tenantId]);
  const row = r.rows[0];
  return {
    sent: row.sent, opens: row.opens, uniqueOpens: row.unique_opens,
    clicks: row.clicks, uniqueClicks: row.unique_clicks, bounced: row.bounced,
  };
}
