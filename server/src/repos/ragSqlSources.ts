import type pg from 'pg';
import { encrypt, decrypt } from '@aiployee/core';

export interface RagSqlSourceRow {
  id: string; tenant_id: string; name: string; enabled: boolean; has_connection: boolean; created_at: Date;
}
const COLS = 'id, tenant_id, name, enabled, (connection_encrypted IS NOT NULL) AS has_connection, created_at';

export async function listRagSqlSources(pool: pg.Pool, tenantId: string): Promise<RagSqlSourceRow[]> {
  const r = await pool.query<RagSqlSourceRow>(
    `SELECT ${COLS} FROM rag_sql_sources WHERE tenant_id = $1 ORDER BY created_at`, [tenantId]);
  return r.rows;
}

export interface RagSqlConn { id: string; name: string; connection: string }

export async function listEnabledRagSqlSourcesWithConn(pool: pg.Pool, key: Buffer, tenantId: string): Promise<RagSqlConn[]> {
  const r = await pool.query<{ id: string; name: string; connection_encrypted: Buffer }>(
    `SELECT id, name, connection_encrypted FROM rag_sql_sources WHERE tenant_id = $1 AND enabled = true`, [tenantId]);
  return r.rows.map(row => ({
    id: row.id, name: row.name, connection: decrypt(row.connection_encrypted, key),
  }));
}

export async function createRagSqlSource(pool: pg.Pool, key: Buffer, input: {
  tenantId: string; name: string; connection: string;
}): Promise<RagSqlSourceRow> {
  const enc = encrypt(input.connection, key);
  const r = await pool.query<RagSqlSourceRow>(
    `INSERT INTO rag_sql_sources (tenant_id, name, connection_encrypted) VALUES ($1,$2,$3) RETURNING ${COLS}`,
    [input.tenantId, input.name, enc]);
  return r.rows[0];
}

export async function deleteRagSqlSource(pool: pg.Pool, tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM rag_sql_sources WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return r.rowCount === 1;
}
