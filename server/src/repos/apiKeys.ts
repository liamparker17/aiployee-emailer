import type pg from 'pg';

export interface ApiKeyRow {
  id: string; tenant_id: string; name: string; key_prefix: string;
  created_at: Date; last_used_at: Date | null; revoked_at: Date | null;
}

export async function insertApiKey(pool: pg.Pool, input: {
  tenantId: string; name: string; keyHash: string; keyPrefix: string;
}): Promise<ApiKeyRow> {
  const r = await pool.query<ApiKeyRow>(
    `INSERT INTO api_keys(tenant_id,name,key_hash,key_prefix)
     VALUES ($1,$2,$3,$4)
     RETURNING id, tenant_id, name, key_prefix, created_at, last_used_at, revoked_at`,
    [input.tenantId, input.name, input.keyHash, input.keyPrefix]);
  return r.rows[0];
}

export async function listApiKeys(pool: pg.Pool, tenantId: string): Promise<ApiKeyRow[]> {
  const r = await pool.query<ApiKeyRow>(
    `SELECT id, tenant_id, name, key_prefix, created_at, last_used_at, revoked_at
     FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return r.rows;
}

export async function revokeApiKey(pool: pg.Pool, tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE api_keys SET revoked_at = now() WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL`,
    [tenantId, id]);
  return r.rowCount === 1;
}
