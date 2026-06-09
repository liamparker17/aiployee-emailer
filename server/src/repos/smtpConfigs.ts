import type pg from 'pg';
import { encrypt, decrypt } from '../crypto/enc.js';

export interface SmtpConfigRow {
  id: string; tenant_id: string; name: string; host: string; port: number;
  secure: boolean; username: string; from_domain: string; is_default: boolean; created_at: Date;
}

export async function createSmtpConfig(pool: pg.Pool, key: Buffer, input: {
  tenantId: string; name: string; host: string; port: number; secure: boolean;
  username: string; password: string; fromDomain: string; isDefault: boolean;
}): Promise<SmtpConfigRow> {
  const enc = encrypt(input.password, key);
  const r = await pool.query<SmtpConfigRow>(
    `INSERT INTO smtp_configs(tenant_id,name,host,port,secure,username,password_encrypted,from_domain,is_default)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, tenant_id, name, host, port, secure, username, from_domain, is_default, created_at`,
    [input.tenantId, input.name, input.host, input.port, input.secure, input.username, enc, input.fromDomain, input.isDefault],
  );
  return r.rows[0];
}

export async function listSmtpConfigs(pool: pg.Pool, tenantId: string): Promise<SmtpConfigRow[]> {
  const r = await pool.query<SmtpConfigRow>(
    `SELECT id, tenant_id, name, host, port, secure, username, from_domain, is_default, created_at
     FROM smtp_configs WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return r.rows;
}

export async function getSmtpConfigWithPassword(
  pool: pg.Pool, key: Buffer, tenantId: string, id: string,
): Promise<(SmtpConfigRow & { password: string }) | null> {
  const r = await pool.query<SmtpConfigRow & { password_encrypted: Buffer }>(
    `SELECT id, tenant_id, name, host, port, secure, username, from_domain, is_default, created_at, password_encrypted
     FROM smtp_configs WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  const row = r.rows[0];
  if (!row) return null;
  const { password_encrypted, ...rest } = row;
  return { ...rest, password: decrypt(password_encrypted, key) };
}

export async function deleteSmtpConfig(pool: pg.Pool, tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM smtp_configs WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return r.rowCount === 1;
}
