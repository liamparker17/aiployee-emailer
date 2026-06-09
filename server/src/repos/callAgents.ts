import type pg from 'pg';
import { encrypt, decrypt } from '../crypto/enc.js';

export interface ValuesField { key: string; label: string; required: boolean; type?: string }

export interface AgentPublic {
  id: string; tenant_id: string; label: string; values_schema: ValuesField[];
  default_timezone: string; active: boolean; hasKey: true;
  created_at: Date; updated_at: Date;
}

export interface AgentForLaunch {
  id: string; tenantId: string; label: string; companyKey: string;
  valuesSchema: ValuesField[]; defaultTimezone: string; active: boolean;
}

interface CreateInput {
  tenantId: string; label: string; companyKey: string;
  valuesSchema: ValuesField[]; defaultTimezone?: string; createdBy?: string;
}

function toPublic(row: Record<string, unknown>): AgentPublic {
  return {
    id: row.id as string, tenant_id: row.tenant_id as string, label: row.label as string,
    values_schema: (row.values_schema as ValuesField[]) ?? [],
    default_timezone: row.default_timezone as string, active: row.active as boolean,
    hasKey: true, created_at: row.created_at as Date, updated_at: row.updated_at as Date,
  };
}

export async function createAgent(pool: pg.Pool, key: Buffer, input: CreateInput): Promise<AgentPublic> {
  const enc = encrypt(input.companyKey, key);
  const r = await pool.query(
    `INSERT INTO call_agents (tenant_id, label, company_key_encrypted, values_schema, default_timezone, created_by)
     VALUES ($1,$2,$3,$4,COALESCE($5,'Africa/Johannesburg'),$6)
     RETURNING id, tenant_id, label, values_schema, default_timezone, active, created_at, updated_at`,
    [input.tenantId, input.label, enc, JSON.stringify(input.valuesSchema ?? []),
     input.defaultTimezone ?? null, input.createdBy ?? null]);
  return toPublic(r.rows[0]);
}

export async function listAgents(pool: pg.Pool, tenantId: string): Promise<AgentPublic[]> {
  const r = await pool.query(
    `SELECT id, tenant_id, label, values_schema, default_timezone, active, created_at, updated_at
     FROM call_agents WHERE tenant_id = $1 ORDER BY label`, [tenantId]);
  return r.rows.map(toPublic);
}

export async function getAgentForLaunch(pool: pg.Pool, key: Buffer, tenantId: string, agentId: string): Promise<AgentForLaunch | null> {
  const r = await pool.query<{ id: string; tenant_id: string; label: string; company_key_encrypted: Buffer;
    values_schema: ValuesField[]; default_timezone: string; active: boolean }>(
    `SELECT id, tenant_id, label, company_key_encrypted, values_schema, default_timezone, active
     FROM call_agents WHERE tenant_id = $1 AND id = $2`, [tenantId, agentId]);
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id, tenantId: row.tenant_id, label: row.label,
    companyKey: decrypt(row.company_key_encrypted, key),
    valuesSchema: row.values_schema ?? [], defaultTimezone: row.default_timezone, active: row.active,
  };
}

interface UpdateInput { label?: string; valuesSchema?: ValuesField[]; defaultTimezone?: string; active?: boolean; companyKey?: string }

export async function updateAgent(pool: pg.Pool, key: Buffer, tenantId: string, agentId: string, patch: UpdateInput): Promise<AgentPublic | null> {
  const sets: string[] = []; const params: unknown[] = [];
  const set = (frag: string, val: unknown) => { params.push(val); sets.push(`${frag} = $${params.length}`); };
  if (patch.label !== undefined) set('label', patch.label);
  if (patch.valuesSchema !== undefined) set('values_schema', JSON.stringify(patch.valuesSchema));
  if (patch.defaultTimezone !== undefined) set('default_timezone', patch.defaultTimezone);
  if (patch.active !== undefined) set('active', patch.active);
  if (patch.companyKey !== undefined) set('company_key_encrypted', encrypt(patch.companyKey, key));
  if (sets.length === 0) { const l = await listAgents(pool, tenantId); return l.find(a => a.id === agentId) ?? null; }
  params.push(tenantId, agentId);
  const r = await pool.query(
    `UPDATE call_agents SET ${sets.join(', ')}, updated_at = now()
     WHERE tenant_id = $${params.length - 1} AND id = $${params.length}
     RETURNING id, tenant_id, label, values_schema, default_timezone, active, created_at, updated_at`, params);
  return r.rows[0] ? toPublic(r.rows[0]) : null;
}
