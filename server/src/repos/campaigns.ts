import type pg from 'pg';

export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'canceled';

export interface CampaignRow {
  id: string;
  tenant_id: string;
  name: string;
  sender_id: string;
  template_id: string | null;
  subject: string | null;
  body_html: string | null;
  audience_type: 'list' | 'segment';
  audience_id: string;
  scheduled_for: Date | null;
  status: CampaignStatus;
  attachments: unknown[];
  created_at: Date;
}

const SELECT = `
  id, tenant_id, name, sender_id, template_id, subject, body_html,
  audience_type, audience_id, scheduled_for, status, attachments, created_at`;

export async function listCampaigns(pool: pg.Pool, tenantId: string): Promise<CampaignRow[]> {
  const r = await pool.query<CampaignRow>(
    `SELECT ${SELECT} FROM campaigns WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );
  return r.rows;
}

export async function getCampaign(
  pool: pg.Pool,
  tenantId: string,
  id: string,
): Promise<CampaignRow | null> {
  const r = await pool.query<CampaignRow>(
    `SELECT ${SELECT} FROM campaigns WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return r.rows[0] ?? null;
}

export async function createCampaign(
  pool: pg.Pool,
  input: {
    tenantId: string;
    name: string;
    senderId: string;
    templateId?: string | null;
    subject?: string | null;
    bodyHtml?: string | null;
    audienceType: 'list' | 'segment';
    audienceId: string;
    scheduledFor?: Date | null;
    attachments?: unknown[];
  },
): Promise<CampaignRow> {
  const r = await pool.query<CampaignRow>(
    `INSERT INTO campaigns
       (tenant_id, name, sender_id, template_id, subject, body_html,
        audience_type, audience_id, scheduled_for, attachments)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     RETURNING ${SELECT}`,
    [
      input.tenantId,
      input.name,
      input.senderId,
      input.templateId ?? null,
      input.subject ?? null,
      input.bodyHtml ?? null,
      input.audienceType,
      input.audienceId,
      input.scheduledFor ?? null,
      JSON.stringify(input.attachments ?? []),
    ],
  );
  return r.rows[0];
}

export async function setCampaignStatus(
  pool: pg.Pool,
  tenantId: string,
  id: string,
  status: CampaignStatus,
): Promise<boolean> {
  const r = await pool.query(
    `UPDATE campaigns SET status = $1 WHERE tenant_id = $2 AND id = $3`,
    [status, tenantId, id],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function deleteCampaign(
  pool: pg.Pool,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const r = await pool.query(
    `DELETE FROM campaigns WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return (r.rowCount ?? 0) > 0;
}

export interface CampaignStats {
  recipients: number;
  sent: number;
  opens: number;
  clicks: number;
  bounced: number;
  replies: number;
  repliers: number;
}

export async function campaignStats(
  pool: pg.Pool,
  tenantId: string,
  id: string,
): Promise<CampaignStats> {
  const r = await pool.query<{
    recipients: string;
    sent: string;
    bounced: string;
    opens: string;
    clicks: string;
    replies: string;
    repliers: string;
  }>(
    `SELECT
       (SELECT count(*)::int  FROM emails
        WHERE campaign_id = $2 AND tenant_id = $1) AS recipients,
       (SELECT count(*)::int  FROM emails
        WHERE campaign_id = $2 AND tenant_id = $1
          AND status IN ('sent','delivered')) AS sent,
       (SELECT count(*)::int  FROM emails
        WHERE campaign_id = $2 AND tenant_id = $1
          AND status = 'bounced') AS bounced,
       (SELECT count(*)::int  FROM email_events ee
        WHERE ee.type = 'open'
          AND ee.email_id IN (
            SELECT id FROM emails WHERE campaign_id = $2 AND tenant_id = $1
          )) AS opens,
       (SELECT count(*)::int  FROM email_events ee
        WHERE ee.type = 'click'
          AND ee.email_id IN (
            SELECT id FROM emails WHERE campaign_id = $2 AND tenant_id = $1
          )) AS clicks,
       (SELECT count(*)::int FROM inbound_emails
        WHERE campaign_id = $2 AND tenant_id = $1) AS replies,
       (SELECT count(DISTINCT from_addr)::int FROM inbound_emails
        WHERE campaign_id = $2 AND tenant_id = $1) AS repliers`,
    [tenantId, id],
  );
  const row = r.rows[0];
  return {
    recipients: Number(row.recipients),
    sent:       Number(row.sent),
    opens:      Number(row.opens),
    clicks:     Number(row.clicks),
    bounced:    Number(row.bounced),
    replies:    Number(row.replies),
    repliers:   Number(row.repliers),
  };
}

export interface CampaignReply {
  id: string;
  from_addr: string;
  from_name: string | null;
  subject: string | null;
  snippet: string | null;
  received_at: Date;
}

// Recent inbound replies correlated to the campaign by the inbox monitor.
export async function campaignReplies(
  pool: pg.Pool,
  tenantId: string,
  id: string,
  limit = 20,
): Promise<CampaignReply[]> {
  const r = await pool.query<CampaignReply>(
    `SELECT id, from_addr, from_name, subject, left(body_text, 240) AS snippet, received_at
     FROM inbound_emails
     WHERE tenant_id = $1 AND campaign_id = $2
     ORDER BY received_at DESC
     LIMIT $3`,
    [tenantId, id, limit],
  );
  return r.rows;
}
