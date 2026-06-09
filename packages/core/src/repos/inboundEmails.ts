import type pg from 'pg';

export interface InboundEmailInput {
  tenantId: string;
  imapConfigId: string;
  imapUid: number;
  messageId: string;
  inReplyTo: string | null;
  references: string | null;
  fromAddr: string;
  fromName: string | null;
  toAddr: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  receivedAt: Date;
  emailId: string | null;
  campaignId: string | null;
  contactId: string | null;
}

export interface InboundEmailRow {
  id: string;
  tenant_id: string;
  campaign_id: string | null;
  email_id: string | null;
  contact_id: string | null;
  from_addr: string;
  subject: string | null;
  body_text: string | null;
  received_at: string;
  status: string;
}

export async function insertInboundEmail(
  pool: pg.Pool, input: InboundEmailInput,
): Promise<{ inserted: boolean; id: string | null }> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO inbound_emails(
        tenant_id, imap_config_id, imap_uid, message_id, in_reply_to, msg_references,
        from_addr, from_name, to_addr, subject, body_text, body_html, received_at,
        email_id, campaign_id, contact_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (tenant_id, message_id) DO NOTHING
     RETURNING id`,
    [
      input.tenantId, input.imapConfigId, input.imapUid, input.messageId, input.inReplyTo, input.references,
      input.fromAddr, input.fromName, input.toAddr, input.subject, input.bodyText, input.bodyHtml, input.receivedAt,
      input.emailId, input.campaignId, input.contactId,
    ],
  );
  const row = r.rows[0];
  return { inserted: !!row, id: row?.id ?? null };
}

export async function listInboundByCampaign(
  pool: pg.Pool, tenantId: string, campaignId: string,
): Promise<InboundEmailRow[]> {
  const r = await pool.query<InboundEmailRow>(
    `SELECT id, tenant_id, campaign_id, email_id, contact_id, from_addr, subject, body_text, received_at, status
     FROM inbound_emails
     WHERE tenant_id = $1 AND campaign_id = $2
     ORDER BY received_at DESC`,
    [tenantId, campaignId],
  );
  return r.rows;
}
