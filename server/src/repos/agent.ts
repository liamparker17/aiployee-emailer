import type pg from 'pg';
import { encrypt, decrypt } from '../crypto/enc.js';

export interface AgentConfigRow {
  id: string; tenant_id: string; enabled: boolean; model: string; system_prompt: string;
  auto_approve_jobix: boolean; max_tool_iterations: number; has_key: boolean;
  jobix_webhook_url: string | null; has_webhook_secret: boolean;
}
export interface ThreadRow {
  id: string; tenant_id: string; jobix_thread_ref: string; subject: string | null; status: string;
  created_at: Date; updated_at: Date;
}
export type MessageRole = 'inbound' | 'agent' | 'system';
export type MessageSource = 'jobix' | 'manual';
export type MessageStatus = 'pending_approval' | 'approved' | 'sent' | 'rejected';
export interface MessageRow {
  id: string; thread_id: string; tenant_id: string; role: MessageRole; source: MessageSource;
  content: string; status: MessageStatus; message_ref: string | null;
  approved_by: string | null; approved_at: Date | null; created_at: Date;
}

const CONFIG_COLS =
  'id, tenant_id, enabled, model, system_prompt, auto_approve_jobix, max_tool_iterations, ' +
  '(openai_key_encrypted IS NOT NULL) AS has_key, jobix_webhook_url, ' +
  '(jobix_webhook_secret_encrypted IS NOT NULL) AS has_webhook_secret';

export async function getAgentConfig(pool: pg.Pool, tenantId: string): Promise<AgentConfigRow | null> {
  const r = await pool.query<AgentConfigRow>(
    `SELECT ${CONFIG_COLS} FROM agent_configs WHERE tenant_id = $1`, [tenantId]);
  return r.rows[0] ?? null;
}

export async function upsertAgentConfig(pool: pg.Pool, key: Buffer, tenantId: string, input: {
  enabled: boolean; model: string; systemPrompt: string; autoApproveJobix: boolean;
  maxToolIterations: number; openaiKey?: string | null;
  jobixWebhookUrl?: string | null; jobixWebhookSecret?: string | null;
}): Promise<AgentConfigRow> {
  // Only overwrite secrets when a new value is supplied (COALESCE keeps the old one).
  const enc = input.openaiKey ? encrypt(input.openaiKey, key) : null;
  const secEnc = input.jobixWebhookSecret ? encrypt(input.jobixWebhookSecret, key) : null;
  const r = await pool.query<AgentConfigRow>(
    `INSERT INTO agent_configs (tenant_id, enabled, model, system_prompt, auto_approve_jobix, max_tool_iterations, openai_key_encrypted, jobix_webhook_url, jobix_webhook_secret_encrypted)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (tenant_id) DO UPDATE SET
       enabled = $2, model = $3, system_prompt = $4, auto_approve_jobix = $5, max_tool_iterations = $6,
       openai_key_encrypted = COALESCE($7, agent_configs.openai_key_encrypted),
       jobix_webhook_url = COALESCE($8, agent_configs.jobix_webhook_url),
       jobix_webhook_secret_encrypted = COALESCE($9, agent_configs.jobix_webhook_secret_encrypted),
       updated_at = now()
     RETURNING ${CONFIG_COLS}`,
    [tenantId, input.enabled, input.model, input.systemPrompt, input.autoApproveJobix, input.maxToolIterations,
     enc, input.jobixWebhookUrl ?? null, secEnc]);
  return r.rows[0];
}

export async function getAgentOpenAIKey(pool: pg.Pool, key: Buffer, tenantId: string): Promise<string | null> {
  const r = await pool.query<{ openai_key_encrypted: Buffer | null }>(
    `SELECT openai_key_encrypted FROM agent_configs WHERE tenant_id = $1`, [tenantId]);
  const blob = r.rows[0]?.openai_key_encrypted;
  return blob ? decrypt(blob, key) : null;
}

export async function getJobixWebhook(pool: pg.Pool, key: Buffer, tenantId: string): Promise<{ url: string; secret: string } | null> {
  const r = await pool.query<{ jobix_webhook_url: string | null; jobix_webhook_secret_encrypted: Buffer | null }>(
    `SELECT jobix_webhook_url, jobix_webhook_secret_encrypted FROM agent_configs WHERE tenant_id = $1`, [tenantId]);
  const row = r.rows[0];
  if (!row?.jobix_webhook_url || !row.jobix_webhook_secret_encrypted) return null;
  return { url: row.jobix_webhook_url, secret: decrypt(row.jobix_webhook_secret_encrypted, key) };
}

export async function upsertThread(pool: pg.Pool, tenantId: string, jobixRef: string, subject?: string | null): Promise<ThreadRow> {
  const r = await pool.query<ThreadRow>(
    `INSERT INTO agent_threads (tenant_id, jobix_thread_ref, subject) VALUES ($1,$2,$3)
     ON CONFLICT (tenant_id, jobix_thread_ref) DO UPDATE SET
       updated_at = now(), subject = COALESCE(agent_threads.subject, EXCLUDED.subject)
     RETURNING *`,
    [tenantId, jobixRef, subject ?? null]);
  return r.rows[0];
}

export async function insertMessage(pool: pg.Pool, input: {
  threadId: string; tenantId: string; role: MessageRole; source: MessageSource;
  content: string; status: MessageStatus; messageRef?: string | null;
}): Promise<MessageRow> {
  const r = await pool.query<MessageRow>(
    `INSERT INTO agent_messages (thread_id, tenant_id, role, source, content, status, message_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [input.threadId, input.tenantId, input.role, input.source, input.content, input.status, input.messageRef ?? null]);
  return r.rows[0];
}

export async function findMessageByRef(pool: pg.Pool, tenantId: string, messageRef: string): Promise<MessageRow | null> {
  const r = await pool.query<MessageRow>(
    `SELECT * FROM agent_messages WHERE tenant_id = $1 AND message_ref = $2`, [tenantId, messageRef]);
  return r.rows[0] ?? null;
}

export async function listThreadMessages(pool: pg.Pool, threadId: string): Promise<MessageRow[]> {
  const r = await pool.query<MessageRow>(
    `SELECT * FROM agent_messages WHERE thread_id = $1 ORDER BY created_at ASC`, [threadId]);
  return r.rows;
}

export async function listThreads(pool: pg.Pool, tenantId: string): Promise<ThreadRow[]> {
  const r = await pool.query<ThreadRow>(
    `SELECT * FROM agent_threads WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT 200`, [tenantId]);
  return r.rows;
}

export async function getThread(pool: pg.Pool, tenantId: string, id: string): Promise<ThreadRow | null> {
  const r = await pool.query<ThreadRow>(
    `SELECT * FROM agent_threads WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return r.rows[0] ?? null;
}

export async function getMessage(pool: pg.Pool, tenantId: string, id: string): Promise<MessageRow | null> {
  const r = await pool.query<MessageRow>(
    `SELECT * FROM agent_messages WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return r.rows[0] ?? null;
}

export async function setMessageStatus(
  pool: pg.Pool, tenantId: string, id: string, status: MessageStatus, approvedBy?: string | null,
): Promise<boolean> {
  const r = await pool.query(
    `UPDATE agent_messages SET status = $3,
       approved_by = CASE WHEN $3 IN ('approved','sent') THEN $4 ELSE approved_by END,
       approved_at = CASE WHEN $3 IN ('approved','sent') THEN now() ELSE approved_at END
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, status, approvedBy ?? null]);
  return r.rowCount === 1;
}
