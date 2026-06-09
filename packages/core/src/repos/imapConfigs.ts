import type pg from 'pg';
import { encrypt, decrypt } from '../crypto/enc.js';

export interface ImapConfigRow {
  id: string;
  tenant_id: string;
  sender_id: string | null;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  enabled: boolean;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLS =
  'id, tenant_id, sender_id, host, port, secure, username, enabled, last_error, created_at, updated_at';

export async function createImapConfig(
  pool: pg.Pool,
  key: Buffer,
  input: {
    tenantId: string; senderId: string | null; host: string; port: number;
    secure: boolean; username: string; password: string; enabled: boolean;
  },
): Promise<ImapConfigRow> {
  const enc = encrypt(input.password, key);
  const r = await pool.query<ImapConfigRow>(
    `INSERT INTO imap_configs(tenant_id, sender_id, host, port, secure, username, password_encrypted, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING ${SELECT_COLS}`,
    [input.tenantId, input.senderId, input.host, input.port, input.secure, input.username, enc, input.enabled],
  );
  return r.rows[0];
}

export async function listEnabledImapConfigs(pool: pg.Pool, tenantId: string): Promise<ImapConfigRow[]> {
  const r = await pool.query<ImapConfigRow>(
    `SELECT ${SELECT_COLS} FROM imap_configs WHERE tenant_id = $1 AND enabled = true ORDER BY created_at DESC`,
    [tenantId],
  );
  return r.rows;
}

export async function listAllEnabledImapConfigs(pool: pg.Pool): Promise<ImapConfigRow[]> {
  const r = await pool.query<ImapConfigRow>(
    `SELECT ${SELECT_COLS} FROM imap_configs WHERE enabled = true ORDER BY tenant_id, created_at`,
  );
  return r.rows;
}

export async function getImapConfigWithPassword(
  pool: pg.Pool,
  key: Buffer,
  id: string,
): Promise<(ImapConfigRow & { password: string }) | null> {
  const r = await pool.query<ImapConfigRow & { password_encrypted: Buffer }>(
    `SELECT ${SELECT_COLS}, password_encrypted FROM imap_configs WHERE id = $1`,
    [id],
  );
  const row = r.rows[0];
  if (!row) return null;
  const { password_encrypted, ...rest } = row;
  return { ...(rest as ImapConfigRow), password: decrypt(password_encrypted, key) };
}

export async function setImapConfigError(pool: pg.Pool, id: string, error: string | null): Promise<void> {
  await pool.query(
    `UPDATE imap_configs SET last_error = $2, updated_at = now() WHERE id = $1`,
    [id, error],
  );
}
