import type pg from 'pg';

export interface ApiKeyRow {
  id: string; tenant_id: string; name: string; key_prefix: string;
  parent_id: string | null;
  created_at: Date; last_used_at: Date | null; revoked_at: Date | null;
}

export async function insertApiKey(pool: pg.Pool, input: {
  tenantId: string; name: string; keyHash: string; keyPrefix: string; parentId?: string | null;
}): Promise<ApiKeyRow> {
  const r = await pool.query<ApiKeyRow>(
    `INSERT INTO api_keys(tenant_id,name,key_hash,key_prefix,parent_id)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id, tenant_id, name, key_prefix, parent_id, created_at, last_used_at, revoked_at`,
    [input.tenantId, input.name, input.keyHash, input.keyPrefix, input.parentId ?? null]);
  return r.rows[0];
}

export async function listApiKeys(pool: pg.Pool, tenantId: string): Promise<ApiKeyRow[]> {
  const r = await pool.query<ApiKeyRow>(
    `SELECT id, tenant_id, name, key_prefix, parent_id, created_at, last_used_at, revoked_at
     FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return r.rows;
}

export async function getApiKeyById(pool: pg.Pool, tenantId: string, id: string): Promise<ApiKeyRow | null> {
  const r = await pool.query<ApiKeyRow>(
    `SELECT id, tenant_id, name, key_prefix, parent_id, created_at, last_used_at, revoked_at
     FROM api_keys WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return r.rows[0] ?? null;
}

/**
 * Revoke a key. If the target is a master (top-level) key, this cascades to all of
 * its non-revoked sub-keys in the same statement. Returns true iff the target key
 * itself was revoked by this call (false if it was missing or already revoked).
 */
export async function revokeApiKey(pool: pg.Pool, tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query<{ id: string }>(
    `UPDATE api_keys SET revoked_at = now()
     WHERE tenant_id = $1 AND (id = $2 OR parent_id = $2) AND revoked_at IS NULL
     RETURNING id`,
    [tenantId, id]);
  return r.rows.some(row => row.id === id);
}

/**
 * Permanently delete a key — only if it is already revoked. Deleting a master key
 * cascades to its sub-keys (parent_id ON DELETE CASCADE); emails that referenced
 * the key keep their row with api_key_id set to NULL. Returns whether a row was
 * deleted (false if not found, not in this tenant, or still active).
 */
export async function deleteApiKeyPermanent(pool: pg.Pool, tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(
    `DELETE FROM api_keys WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NOT NULL`,
    [tenantId, id]);
  return r.rowCount === 1;
}
