import type pg from 'pg';

export interface Sender {
  id: string; tenant_id: string; email: string; display_name: string;
  reply_to: string | null; smtp_config_id: string; is_default: boolean; created_at: Date;
}

export async function createSender(pool: pg.Pool, input: {
  tenantId: string; email: string; displayName: string;
  replyTo?: string | null; smtpConfigId: string; isDefault?: boolean;
}): Promise<Sender> {
  const r = await pool.query<Sender>(
    `INSERT INTO senders(tenant_id,email,display_name,reply_to,smtp_config_id,is_default)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, tenant_id, email, display_name, reply_to, smtp_config_id, is_default, created_at`,
    [input.tenantId, input.email, input.displayName, input.replyTo ?? null, input.smtpConfigId, input.isDefault ?? false],
  );
  return r.rows[0];
}

export async function listSenders(pool: pg.Pool, tenantId: string): Promise<Sender[]> {
  const r = await pool.query<Sender>(
    `SELECT id, tenant_id, email, display_name, reply_to, smtp_config_id, is_default, created_at
     FROM senders WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return r.rows;
}

export async function getSenderByEmail(pool: pg.Pool, tenantId: string, email: string): Promise<Sender | null> {
  const r = await pool.query<Sender>(
    `SELECT id, tenant_id, email, display_name, reply_to, smtp_config_id, is_default, created_at
     FROM senders WHERE tenant_id = $1 AND email = $2`, [tenantId, email]);
  return r.rows[0] ?? null;
}

export async function getSenderById(pool: pg.Pool, tenantId: string, id: string): Promise<Sender | null> {
  const r = await pool.query<Sender>(
    `SELECT id, tenant_id, email, display_name, reply_to, smtp_config_id, is_default, created_at
     FROM senders WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return r.rows[0] ?? null;
}

export async function getDefaultSender(pool: pg.Pool, tenantId: string): Promise<Sender | null> {
  const r = await pool.query<Sender>(
    `SELECT id, tenant_id, email, display_name, reply_to, smtp_config_id, is_default, created_at
     FROM senders WHERE tenant_id = $1 AND is_default = true ORDER BY created_at ASC LIMIT 1`,
    [tenantId],
  );
  return r.rows[0] ?? null;
}

/** The sender identity tied to an SMTP config — for relay setups (e.g. Mimecast)
 *  the From address must be this, not the relay's auth username. */
export async function getSenderForSmtpConfig(pool: pg.Pool, tenantId: string, smtpConfigId: string): Promise<Sender | null> {
  const r = await pool.query<Sender>(
    `SELECT id, tenant_id, email, display_name, reply_to, smtp_config_id, is_default, created_at
     FROM senders WHERE tenant_id = $1 AND smtp_config_id = $2 ORDER BY is_default DESC, created_at ASC LIMIT 1`,
    [tenantId, smtpConfigId]);
  return r.rows[0] ?? null;
}

export async function deleteSender(pool: pg.Pool, tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM senders WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return r.rowCount === 1;
}
