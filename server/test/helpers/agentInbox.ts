// server/test/helpers/agentInbox.ts
import pg from 'pg';

/** Minimal imap_configs row so inbound_emails (imap_config_id NOT NULL) can be inserted in tests. */
export async function createImapConfig(pool: pg.Pool, tenantId: string): Promise<{ id: string }> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO imap_configs(tenant_id, host, port, secure, username, password_encrypted, auth_type)
     VALUES ($1,'imap.test',993,true,'inbox@test',$2,'password') RETURNING id`,
    [tenantId, Buffer.from('x')],
  );
  return r.rows[0];
}

/** Insert a correlated inbound reply (contact_id + campaign_id set), as the IMAP pipeline would. */
export async function seedCorrelatedReply(pool: pg.Pool, input: {
  tenantId: string; imapConfigId: string; contactId: string; campaignId: string | null;
  fromAddr: string; fromName?: string; subject?: string; bodyText?: string; receivedAt?: Date; messageId?: string;
}): Promise<{ id: string }> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO inbound_emails(
       tenant_id, imap_config_id, imap_uid, message_id, from_addr, from_name, subject, body_text,
       received_at, campaign_id, contact_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      input.tenantId, input.imapConfigId, Math.floor(Math.random() * 1e9),
      input.messageId ?? '<' + Math.random().toString(36).slice(2) + '@test>',
      input.fromAddr, input.fromName ?? null, input.subject ?? 'Re: Hello', input.bodyText ?? 'Hi there',
      input.receivedAt ?? new Date(), input.campaignId, input.contactId,
    ],
  );
  return r.rows[0];
}
