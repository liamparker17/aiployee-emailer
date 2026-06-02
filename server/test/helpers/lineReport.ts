import type pg from 'pg';

// Inserts a Jobix-style inbound call summary into agent_threads/agent_messages.
export async function seedInboundCall(
  pool: pg.Pool, tenantId: string, content: string, createdAt?: Date,
): Promise<{ id: string; thread_id: string }> {
  const th = await pool.query<{ id: string }>(
    `INSERT INTO agent_threads (tenant_id, jobix_thread_ref) VALUES ($1, $2) RETURNING id`,
    [tenantId, 'call-' + Math.random().toString(36).slice(2)]);
  const msg = await pool.query<{ id: string; thread_id: string }>(
    `INSERT INTO agent_messages (thread_id, tenant_id, role, source, content, status, created_at)
     VALUES ($1, $2, 'inbound', 'jobix', $3, 'sent', COALESCE($4, now()))
     RETURNING id, thread_id`,
    [th.rows[0].id, tenantId, content, createdAt ?? null]);
  return msg.rows[0];
}
