import type pg from 'pg';

export interface CallTagRow {
  id: string; tenant_id: string; message_id: string;
  category: string; severity: 'low'|'med'|'high'; is_emerging: boolean; created_at: Date;
}
export interface InboundRow { id: string; content: string; created_at: Date; }
export interface CategoryCount { category: string; count: number; }

// Tag-once: unique(message_id) means a second tag for the same call is ignored.
export async function insertCallTag(pool: pg.Pool, a: {
  tenantId: string; messageId: string; category: string;
  severity: 'low'|'med'|'high'; isEmerging: boolean;
}): Promise<void> {
  await pool.query(
    `INSERT INTO line_call_tags (tenant_id, message_id, category, severity, is_emerging)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (message_id) DO NOTHING`,
    [a.tenantId, a.messageId, a.category, a.severity, a.isEmerging]);
}

export async function listUntaggedInbound(pool: pg.Pool, tenantId: string, limit: number): Promise<InboundRow[]> {
  const r = await pool.query<InboundRow>(
    `SELECT m.id, m.content, m.created_at
       FROM agent_messages m
       LEFT JOIN line_call_tags t ON t.message_id = m.id
      WHERE m.tenant_id = $1 AND m.role = 'inbound' AND t.id IS NULL
      ORDER BY m.created_at ASC
      LIMIT $2`, [tenantId, limit]);
  return r.rows;
}

export async function aggregateByCategory(
  pool: pg.Pool, tenantId: string, start: Date, end: Date,
): Promise<CategoryCount[]> {
  const r = await pool.query<{ category: string; count: string }>(
    `SELECT category, COUNT(*)::text AS count
       FROM line_call_tags
      WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
      GROUP BY category ORDER BY COUNT(*) DESC`, [tenantId, start, end]);
  return r.rows.map(x => ({ category: x.category, count: Number(x.count) }));
}

export async function listHighSeverityUnreported(
  pool: pg.Pool, tenantId: string, since: Date,
): Promise<Array<{ id: string; message_id: string; content: string }>> {
  // High-severity tags whose message isn't already referenced by a 'case' report.
  const r = await pool.query<{ id: string; message_id: string; content: string }>(
    `SELECT t.id, t.message_id, m.content
       FROM line_call_tags t
       JOIN agent_messages m ON m.id = t.message_id
      WHERE t.tenant_id = $1 AND t.severity = 'high' AND t.created_at >= $2
        AND NOT EXISTS (
          SELECT 1 FROM line_reports r
           WHERE r.tenant_id = $1 AND r.report_type = 'case'
             AND r.source_message_ids @> to_jsonb(ARRAY[t.message_id::text]))
      ORDER BY t.created_at ASC`, [tenantId, since]);
  return r.rows;
}
