import type pg from 'pg';
import { encrypt, decrypt } from '../crypto/enc.js';

export interface McpServerRow {
  id: string; tenant_id: string; name: string; url: string; enabled: boolean; has_auth: boolean; created_at: Date;
}
const COLS = 'id, tenant_id, name, url, enabled, (auth_header_encrypted IS NOT NULL) AS has_auth, created_at';

export async function listMcpServers(pool: pg.Pool, tenantId: string): Promise<McpServerRow[]> {
  const r = await pool.query<McpServerRow>(
    `SELECT ${COLS} FROM mcp_servers WHERE tenant_id = $1 ORDER BY created_at`, [tenantId]);
  return r.rows;
}

export interface McpServerConn { id: string; name: string; url: string; auth: string | null }

export async function listEnabledMcpServersWithAuth(pool: pg.Pool, key: Buffer, tenantId: string): Promise<McpServerConn[]> {
  const r = await pool.query<{ id: string; name: string; url: string; auth_header_encrypted: Buffer | null }>(
    `SELECT id, name, url, auth_header_encrypted FROM mcp_servers WHERE tenant_id = $1 AND enabled = true`, [tenantId]);
  return r.rows.map(row => ({
    id: row.id, name: row.name, url: row.url,
    auth: row.auth_header_encrypted ? decrypt(row.auth_header_encrypted, key) : null,
  }));
}

export async function createMcpServer(pool: pg.Pool, key: Buffer, input: {
  tenantId: string; name: string; url: string; authHeader?: string | null;
}): Promise<McpServerRow> {
  const enc = input.authHeader ? encrypt(input.authHeader, key) : null;
  const r = await pool.query<McpServerRow>(
    `INSERT INTO mcp_servers (tenant_id, name, url, auth_header_encrypted) VALUES ($1,$2,$3,$4) RETURNING ${COLS}`,
    [input.tenantId, input.name, input.url, enc]);
  return r.rows[0];
}

export async function deleteMcpServer(pool: pg.Pool, tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM mcp_servers WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return r.rowCount === 1;
}
