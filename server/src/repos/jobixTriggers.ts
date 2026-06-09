import type pg from 'pg';
import { encrypt, decrypt } from '@aiployee/core';
import { AppError } from '@aiployee/core';
import { validateTriggerUrl } from '../jobix/validateTriggerUrl.js';

export type TokenPlacement = 'bearer' | 'header' | 'query' | 'body';
const DEFAULT_URL = 'https://dashboard-api.jobix.ai/automation/trigger/webhook';

export interface TriggerPublic {
  id: string; tenant_id: string; label: string; url: string;
  token_placement: TokenPlacement; token_param: string | null; payload_template: string;
  active: boolean; last_fired_at: Date | null; hasToken: true;
  created_at: Date; updated_at: Date;
}
export interface TriggerForFire {
  id: string; tenantId: string; label: string; url: string; token: string;
  tokenPlacement: TokenPlacement; tokenParam: string | null; payloadTemplate: string; active: boolean;
}

interface CreateInput {
  tenantId: string; label: string; url?: string; token: string;
  tokenPlacement: TokenPlacement; tokenParam?: string | null; payloadTemplate: string; createdBy?: string;
}

const PUBLIC_COLS =
  'id, tenant_id, label, url, token_placement, token_param, payload_template, active, last_fired_at, created_at, updated_at';

function toPublic(row: Record<string, unknown>): TriggerPublic {
  return {
    id: row.id as string, tenant_id: row.tenant_id as string, label: row.label as string, url: row.url as string,
    token_placement: row.token_placement as TokenPlacement, token_param: (row.token_param as string) ?? null,
    payload_template: row.payload_template as string, active: row.active as boolean,
    last_fired_at: (row.last_fired_at as Date) ?? null, hasToken: true,
    created_at: row.created_at as Date, updated_at: row.updated_at as Date,
  };
}

function assertPlacement(placement: TokenPlacement, param: string | null | undefined): void {
  if (placement !== 'bearer' && !param) {
    throw new AppError('token_param_required', 400, `token_param is required for placement '${placement}'`);
  }
}

export async function createTrigger(pool: pg.Pool, key: Buffer, input: CreateInput): Promise<TriggerPublic> {
  const url = (input.url && input.url.trim()) || DEFAULT_URL;
  validateTriggerUrl(url);
  assertPlacement(input.tokenPlacement, input.tokenParam);
  const enc = encrypt(input.token, key);
  const r = await pool.query(
    `INSERT INTO jobix_triggers (tenant_id, label, url, token_encrypted, token_placement, token_param, payload_template, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${PUBLIC_COLS}`,
    [input.tenantId, input.label, url, enc, input.tokenPlacement, input.tokenParam ?? null, input.payloadTemplate, input.createdBy ?? null]);
  return toPublic(r.rows[0]);
}

export async function listTriggers(pool: pg.Pool, tenantId: string): Promise<TriggerPublic[]> {
  const r = await pool.query(`SELECT ${PUBLIC_COLS} FROM jobix_triggers WHERE tenant_id = $1 ORDER BY label`, [tenantId]);
  return r.rows.map(toPublic);
}

export async function getTriggerForFire(pool: pg.Pool, key: Buffer, tenantId: string, id: string): Promise<TriggerForFire | null> {
  const r = await pool.query<{ id: string; tenant_id: string; label: string; url: string; token_encrypted: Buffer;
    token_placement: TokenPlacement; token_param: string | null; payload_template: string; active: boolean }>(
    `SELECT id, tenant_id, label, url, token_encrypted, token_placement, token_param, payload_template, active
     FROM jobix_triggers WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id, tenantId: row.tenant_id, label: row.label, url: row.url, token: decrypt(row.token_encrypted, key),
    tokenPlacement: row.token_placement, tokenParam: row.token_param, payloadTemplate: row.payload_template, active: row.active,
  };
}

interface UpdateInput {
  label?: string; url?: string; token?: string; tokenPlacement?: TokenPlacement;
  tokenParam?: string | null; payloadTemplate?: string; active?: boolean;
}

export async function updateTrigger(pool: pg.Pool, key: Buffer, tenantId: string, id: string, patch: UpdateInput): Promise<TriggerPublic | null> {
  if (patch.url !== undefined) validateTriggerUrl((patch.url && patch.url.trim()) || DEFAULT_URL);
  if (patch.tokenPlacement !== undefined && patch.tokenPlacement !== 'bearer' && patch.tokenParam === undefined) {
    const cur = await pool.query<{ token_param: string | null }>(`SELECT token_param FROM jobix_triggers WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
    assertPlacement(patch.tokenPlacement, cur.rows[0]?.token_param ?? null);
  } else if (patch.tokenPlacement !== undefined) {
    assertPlacement(patch.tokenPlacement, patch.tokenParam ?? null);
  }
  const sets: string[] = []; const params: unknown[] = [];
  const set = (frag: string, val: unknown) => { params.push(val); sets.push(`${frag} = $${params.length}`); };
  if (patch.label !== undefined) set('label', patch.label);
  if (patch.url !== undefined) set('url', (patch.url && patch.url.trim()) || DEFAULT_URL);
  if (patch.token !== undefined) set('token_encrypted', encrypt(patch.token, key));
  if (patch.tokenPlacement !== undefined) set('token_placement', patch.tokenPlacement);
  if (patch.tokenParam !== undefined) set('token_param', patch.tokenParam);
  if (patch.payloadTemplate !== undefined) set('payload_template', patch.payloadTemplate);
  if (patch.active !== undefined) set('active', patch.active);
  if (sets.length === 0) {
    const r = await pool.query(`SELECT ${PUBLIC_COLS} FROM jobix_triggers WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
    return r.rows[0] ? toPublic(r.rows[0]) : null;
  }
  params.push(tenantId, id);
  const r = await pool.query(
    `UPDATE jobix_triggers SET ${sets.join(', ')}, updated_at = now()
     WHERE tenant_id = $${params.length - 1} AND id = $${params.length} RETURNING ${PUBLIC_COLS}`, params);
  return r.rows[0] ? toPublic(r.rows[0]) : null;
}

export async function deleteTrigger(pool: pg.Pool, tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM jobix_triggers WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return (r.rowCount ?? 0) > 0;
}

export type FireSource = 'manual' | 'test' | 'event' | 'abe';

export interface FireRow {
  id: string; tenant_id: string; trigger_id: string; source: FireSource;
  vars: Record<string, unknown>; http_status: number | null; ok: boolean;
  response_snippet: string | null; error: string | null; created_by: string | null; created_at: Date;
}

export interface RecordFireInput {
  tenantId: string; triggerId: string; source: FireSource; vars: Record<string, unknown>;
  httpStatus: number | null; ok: boolean; responseSnippet: string | null; error: string | null; createdBy: string | null;
}

export async function recordFire(pool: pg.Pool, f: RecordFireInput): Promise<void> {
  await pool.query(
    `INSERT INTO jobix_trigger_fires (tenant_id, trigger_id, source, vars, http_status, ok, response_snippet, error, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [f.tenantId, f.triggerId, f.source, JSON.stringify(f.vars ?? {}), f.httpStatus, f.ok,
     f.responseSnippet ? f.responseSnippet.slice(0, 2000) : null, f.error ? f.error.slice(0, 2000) : null, f.createdBy]);
}

export async function listFires(pool: pg.Pool, tenantId: string, triggerId: string, opts: { limit?: number; offset?: number }): Promise<{ fires: FireRow[]; total: number }> {
  const total = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM jobix_trigger_fires WHERE tenant_id = $1 AND trigger_id = $2`, [tenantId, triggerId]);
  const r = await pool.query<FireRow>(
    `SELECT * FROM jobix_trigger_fires WHERE tenant_id = $1 AND trigger_id = $2
     ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
    [tenantId, triggerId, opts.limit ?? 50, opts.offset ?? 0]);
  return { fires: r.rows, total: Number(total.rows[0].n) };
}

export async function touchLastFired(pool: pg.Pool, tenantId: string, id: string): Promise<void> {
  await pool.query(`UPDATE jobix_triggers SET last_fired_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
}
