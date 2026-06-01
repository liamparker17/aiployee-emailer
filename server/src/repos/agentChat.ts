import type pg from 'pg';
export type ChatRole = 'user' | 'abe';
export interface ChatMessageRow { id: string; tenant_id: string; role: ChatRole; content: string; created_at: Date; }

export async function insertChatMessage(pool: pg.Pool, tenantId: string, role: ChatRole, content: string): Promise<ChatMessageRow> {
  const r = await pool.query<ChatMessageRow>(
    `INSERT INTO agent_chat_messages (tenant_id, role, content) VALUES ($1,$2,$3) RETURNING *`,
    [tenantId, role, content]);
  return r.rows[0];
}
export async function listChatMessages(pool: pg.Pool, tenantId: string): Promise<ChatMessageRow[]> {
  const r = await pool.query<ChatMessageRow>(
    `SELECT * FROM agent_chat_messages WHERE tenant_id = $1 ORDER BY created_at ASC`, [tenantId]);
  return r.rows;
}
