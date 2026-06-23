import type pg from 'pg';
import { encrypt, decrypt } from '@aiployee/core';

export interface SmtpConfigRow {
  id: string; tenant_id: string; name: string; host: string; port: number;
  secure: boolean; username: string; from_domain: string; is_default: boolean; created_at: Date;
  auth_type: 'password' | 'xoauth2' | 'graph'; oauth_client_id: string | null; oauth_tenant: string | null;
}

const SELECT_COLS =
  'id, tenant_id, name, host, port, secure, username, from_domain, is_default, created_at, auth_type, oauth_client_id, oauth_tenant';

export async function createSmtpConfig(pool: pg.Pool, key: Buffer, input: {
  tenantId: string; name: string; host: string; port: number; secure: boolean;
  username: string; password: string; fromDomain: string; isDefault: boolean;
}): Promise<SmtpConfigRow> {
  const enc = encrypt(input.password, key);
  const r = await pool.query<SmtpConfigRow>(
    `INSERT INTO smtp_configs(tenant_id,name,host,port,secure,username,password_encrypted,from_domain,is_default)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING ${SELECT_COLS}`,
    [input.tenantId, input.name, input.host, input.port, input.secure, input.username, enc, input.fromDomain, input.isDefault],
  );
  return r.rows[0];
}

export async function createSmtpConfigOauth(
  pool: pg.Pool,
  key: Buffer,
  input: {
    tenantId: string; name: string; host: string; port: number; secure: boolean;
    username: string; fromDomain: string; isDefault: boolean;
    clientId: string; oauthTenant: string; refreshToken: string;
  },
): Promise<SmtpConfigRow> {
  const enc = encrypt(input.refreshToken, key);
  const r = await pool.query<SmtpConfigRow>(
    `INSERT INTO smtp_configs(tenant_id, name, host, port, secure, username, from_domain, is_default,
                              auth_type, oauth_client_id, oauth_tenant, oauth_refresh_token_encrypted)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'xoauth2',$9,$10,$11)
     RETURNING ${SELECT_COLS}`,
    [input.tenantId, input.name, input.host, input.port, input.secure, input.username,
     input.fromDomain, input.isDefault, input.clientId, input.oauthTenant, enc],
  );
  return r.rows[0];
}

export async function createSmtpConfigGraph(
  pool: pg.Pool,
  key: Buffer,
  input: {
    tenantId: string; name: string; username: string; fromDomain: string; isDefault: boolean;
    clientId: string; oauthTenant: string; refreshToken: string;
  },
): Promise<SmtpConfigRow> {
  const enc = encrypt(input.refreshToken, key);
  const r = await pool.query<SmtpConfigRow>(
    `INSERT INTO smtp_configs(tenant_id, name, host, port, secure, username, from_domain, is_default,
                              auth_type, oauth_client_id, oauth_tenant, oauth_refresh_token_encrypted,
                              password_encrypted)
     VALUES ($1,$2,'graph.microsoft.com',443,true,$3,$4,$5,'graph',$6,$7,$8,NULL)
     RETURNING ${SELECT_COLS}`,
    [input.tenantId, input.name, input.username, input.fromDomain, input.isDefault,
     input.clientId, input.oauthTenant, enc],
  );
  return r.rows[0];
}

export async function listSmtpConfigs(pool: pg.Pool, tenantId: string): Promise<SmtpConfigRow[]> {
  const r = await pool.query<SmtpConfigRow>(
    `SELECT ${SELECT_COLS}
     FROM smtp_configs WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return r.rows;
}

export async function getSmtpConfigWithPassword(
  pool: pg.Pool, key: Buffer, tenantId: string, id: string,
): Promise<(SmtpConfigRow & { password: string | null; refreshToken: string | null }) | null> {
  const r = await pool.query<SmtpConfigRow & { password_encrypted: Buffer | null; oauth_refresh_token_encrypted: Buffer | null }>(
    `SELECT ${SELECT_COLS}, password_encrypted, oauth_refresh_token_encrypted
     FROM smtp_configs WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  const row = r.rows[0];
  if (!row) return null;
  const { password_encrypted, oauth_refresh_token_encrypted, ...rest } = row;
  return {
    ...(rest as SmtpConfigRow),
    password: password_encrypted ? decrypt(password_encrypted, key) : null,
    refreshToken: oauth_refresh_token_encrypted ? decrypt(oauth_refresh_token_encrypted, key) : null,
  };
}

/** Upgrade an existing smtp_config (any auth_type) to Graph in-place.
 * Preserves the row id so all FK references (senders etc.) remain valid.
 * Clears password_encrypted and sets the new Graph OAuth credentials. */
export async function upgradeSmtpConfigToGraph(
  pool: pg.Pool,
  key: Buffer,
  id: string,
  input: { clientId: string; oauthTenant: string; refreshToken: string },
): Promise<SmtpConfigRow> {
  const enc = encrypt(input.refreshToken, key);
  const r = await pool.query<SmtpConfigRow>(
    `UPDATE smtp_configs
        SET auth_type='graph', oauth_client_id=$2, oauth_tenant=$3, oauth_refresh_token_encrypted=$4, password_encrypted=NULL
      WHERE id=$1
      RETURNING ${SELECT_COLS}`,
    [id, input.clientId, input.oauthTenant, enc],
  );
  return r.rows[0];
}

export async function updateSmtpRefreshToken(pool: pg.Pool, key: Buffer, id: string, refreshToken: string): Promise<void> {
  await pool.query(
    `UPDATE smtp_configs SET oauth_refresh_token_encrypted = $2 WHERE id = $1`,
    [id, encrypt(refreshToken, key)],
  );
}

export async function deleteSmtpConfig(pool: pg.Pool, tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM smtp_configs WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return r.rowCount === 1;
}
