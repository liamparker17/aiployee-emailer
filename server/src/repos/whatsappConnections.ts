import type pg from 'pg';
import { encrypt, decrypt } from '@aiployee/core';
import { AppError } from '@aiployee/core';
import type { WaConnectionForSend } from '../whatsapp/client.js';

export interface WaConnectionPublic {
  id: string; tenant_id: string; base_url: string; from_number: string | null;
  active: boolean; last_ok_at: Date | null; last_error: string | null; hasKey: true;
  created_at: Date; updated_at: Date;
}

const PUBLIC_COLS = 'id, tenant_id, base_url, from_number, active, last_ok_at, last_error, created_at, updated_at';

function toPublic(row: Record<string, unknown>): WaConnectionPublic {
  return {
    id: row.id as string, tenant_id: row.tenant_id as string, base_url: row.base_url as string,
    from_number: (row.from_number as string) ?? null, active: row.active as boolean,
    last_ok_at: (row.last_ok_at as Date) ?? null, last_error: (row.last_error as string) ?? null,
    hasKey: true, created_at: row.created_at as Date, updated_at: row.updated_at as Date,
  };
}

export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export async function getConnection(pool: pg.Pool, tenantId: string): Promise<WaConnectionPublic | null> {
  const r = await pool.query(`SELECT ${PUBLIC_COLS} FROM whatsapp_connections WHERE tenant_id = $1`, [tenantId]);
  return r.rows[0] ? toPublic(r.rows[0]) : null;
}

export interface UpsertInput {
  tenantId: string; baseUrl: string; apiKey?: string;
  fromNumber?: string | null; active?: boolean; createdBy?: string;
}

export async function upsertConnection(pool: pg.Pool, key: Buffer, input: UpsertInput): Promise<WaConnectionPublic> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const existing = await pool.query<{ id: string }>(
    'SELECT id FROM whatsapp_connections WHERE tenant_id = $1', [input.tenantId]);

  if (!existing.rows[0]) {
    if (!input.apiKey) throw new AppError('api_key_required', 400, 'An API key is required to create the connection');
    const r = await pool.query(
      `INSERT INTO whatsapp_connections (tenant_id, base_url, api_key_encrypted, from_number, active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${PUBLIC_COLS}`,
      [input.tenantId, baseUrl, encrypt(input.apiKey, key), input.fromNumber ?? null, input.active ?? true, input.createdBy ?? null]);
    return toPublic(r.rows[0]);
  }

  const sets: string[] = []; const params: unknown[] = [];
  const set = (frag: string, val: unknown) => { params.push(val); sets.push(`${frag} = $${params.length}`); };
  set('base_url', baseUrl);
  if (input.apiKey !== undefined) set('api_key_encrypted', encrypt(input.apiKey, key));
  if (input.fromNumber !== undefined) set('from_number', input.fromNumber);
  if (input.active !== undefined) set('active', input.active);
  params.push(input.tenantId);
  const r = await pool.query(
    `UPDATE whatsapp_connections SET ${sets.join(', ')}, updated_at = now()
     WHERE tenant_id = $${params.length} RETURNING ${PUBLIC_COLS}`, params);
  return toPublic(r.rows[0]);
}

export async function getConnectionForSend(pool: pg.Pool, key: Buffer, tenantId: string): Promise<WaConnectionForSend | null> {
  const r = await pool.query<{ id: string; tenant_id: string; base_url: string; api_key_encrypted: Buffer; from_number: string | null; active: boolean }>(
    'SELECT id, tenant_id, base_url, api_key_encrypted, from_number, active FROM whatsapp_connections WHERE tenant_id = $1', [tenantId]);
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id, tenantId: row.tenant_id, baseUrl: row.base_url,
    apiKey: decrypt(row.api_key_encrypted, key), fromNumber: row.from_number, active: row.active,
  };
}

export async function deleteConnection(pool: pg.Pool, tenantId: string): Promise<boolean> {
  const r = await pool.query('DELETE FROM whatsapp_connections WHERE tenant_id = $1', [tenantId]);
  return (r.rowCount ?? 0) > 0;
}

export async function recordSendResult(pool: pg.Pool, tenantId: string, ok: boolean, error: string | null): Promise<void> {
  if (ok) {
    await pool.query('UPDATE whatsapp_connections SET last_ok_at = now(), last_error = NULL, updated_at = now() WHERE tenant_id = $1', [tenantId]);
  } else {
    await pool.query('UPDATE whatsapp_connections SET last_error = $2, updated_at = now() WHERE tenant_id = $1', [tenantId, error]);
  }
}
