import type pg from 'pg';

export interface CallRow {
  id: string; created_at: Date; content: string;
  category: string | null; severity: string | null;
}

export async function listCalls(pool: pg.Pool, tenantId: string, opts: {
  category?: string; search?: string; from?: Date; to?: Date; limit?: number; offset?: number;
}): Promise<{ calls: CallRow[]; total: number }> {
  const where = [`m.tenant_id = $1`, `m.role = 'inbound'`];
  const params: unknown[] = [tenantId];
  if (opts.category) { params.push(opts.category); where.push(`t.category = $${params.length}`); }
  if (opts.search)   { params.push('%' + opts.search + '%'); where.push(`m.content ILIKE $${params.length}`); }
  if (opts.from)     { params.push(opts.from); where.push(`m.created_at >= $${params.length}`); }
  if (opts.to)       { params.push(opts.to);   where.push(`m.created_at < $${params.length}`); }
  const whereSql = where.join(' AND ');
  const totalR = await pool.query<{ n: string }>(
    `SELECT count(*)::text n FROM agent_messages m
       LEFT JOIN line_call_tags t ON t.message_id = m.id WHERE ${whereSql}`, params);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  params.push(limit); const limIdx = params.length;
  params.push(offset); const offIdx = params.length;
  const r = await pool.query<CallRow>(
    `SELECT m.id, m.created_at, m.content, t.category, t.severity
       FROM agent_messages m LEFT JOIN line_call_tags t ON t.message_id = m.id
      WHERE ${whereSql} ORDER BY m.created_at DESC LIMIT $${limIdx} OFFSET $${offIdx}`, params);
  return { calls: r.rows, total: Number(totalR.rows[0].n) };
}

export async function getCall(pool: pg.Pool, tenantId: string, id: string): Promise<CallRow | null> {
  const r = await pool.query<CallRow>(
    `SELECT m.id, m.created_at, m.content, t.category, t.severity
       FROM agent_messages m LEFT JOIN line_call_tags t ON t.message_id = m.id
      WHERE m.tenant_id = $1 AND m.id = $2 AND m.role = 'inbound'`, [tenantId, id]);
  return r.rows[0] ?? null;
}

export async function sampleInboundContents(pool: pg.Pool, tenantId: string, n: number): Promise<string[]> {
  const r = await pool.query<{ content: string }>(
    `SELECT content FROM agent_messages WHERE tenant_id = $1 AND role = 'inbound'
      ORDER BY created_at DESC LIMIT $2`, [tenantId, n]);
  return r.rows.map(x => x.content);
}

export async function deleteTagsForTenant(pool: pg.Pool, tenantId: string): Promise<number> {
  const r = await pool.query(`DELETE FROM line_call_tags WHERE tenant_id = $1`, [tenantId]);
  return r.rowCount ?? 0;
}

export async function breakdownByCategory(
  pool: pg.Pool, tenantId: string, start: Date, end: Date,
): Promise<Array<{ category: string; count: number }>> {
  const r = await pool.query<{ category: string; count: string }>(
    `SELECT COALESCE(t.category, 'Untagged') category, count(*)::text count
       FROM agent_messages m LEFT JOIN line_call_tags t ON t.message_id = m.id
      WHERE m.tenant_id = $1 AND m.role = 'inbound' AND m.created_at >= $2 AND m.created_at < $3
      GROUP BY 1 ORDER BY count(*) DESC`, [tenantId, start, end]);
  return r.rows.map(x => ({ category: x.category, count: Number(x.count) }));
}

export async function callsPerDay(
  pool: pg.Pool, tenantId: string, start: Date, end: Date,
): Promise<Array<{ day: string; count: number }>> {
  const r = await pool.query<{ call_day: string; count: string }>(
    `SELECT to_char(m.created_at::date, 'YYYY-MM-DD') AS call_day, count(*)::text AS count
       FROM agent_messages m
      WHERE m.tenant_id = $1 AND m.role = 'inbound' AND m.created_at >= $2 AND m.created_at < $3
      GROUP BY 1 ORDER BY 1`, [tenantId, start, end]);
  return r.rows.map(x => ({ day: x.call_day, count: Number(x.count) }));
}

export async function countCallsMatching(
  pool: pg.Pool, tenantId: string, text: string, start: Date, end: Date,
): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text n FROM agent_messages
      WHERE tenant_id = $1 AND role = 'inbound' AND content ILIKE $2
        AND created_at >= $3 AND created_at < $4`, [tenantId, '%' + text + '%', start, end]);
  return Number(r.rows[0].n);
}
