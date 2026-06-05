import type pg from 'pg';

export interface CallRow {
  id: string; created_at: Date; content: string;
  category: string | null; severity: string | null;
  caller_name: string | null; caller_phone: string | null;
  attribution_label: string | null; call_type: string | null;
  call_outcome: string | null; sentiment: string | null;
  call_duration_seconds: number | null;
  callback_requested: boolean | null; escalation_requested: boolean | null;
  resolution_state: string | null;
}

// Allow-lists: map API field names to SQL columns. User input never reaches SQL directly.
const SORT_COLUMNS: Record<string, string> = {
  created_at: 'm.created_at', attribution_label: 'f.attribution_label', category: 't.category',
  call_outcome: 'f.call_outcome', sentiment: 'f.sentiment',
  call_duration_seconds: 'f.call_duration_seconds', resolution_state: 'f.resolution_state',
};
export const BREAKDOWN_COLUMNS: Record<string, string> = {
  attribution_label: 'f.attribution_label', category: 't.category',
  call_outcome: 'f.call_outcome', sentiment: 'f.sentiment', resolution_state: 'f.resolution_state',
};

const CALL_FROM = `agent_messages m
       LEFT JOIN call_facts f     ON f.message_id = m.id
       LEFT JOIN line_call_tags t ON t.message_id = m.id`;
const CALL_COLS = `m.id, m.created_at, m.content, t.category, t.severity,
       f.caller_name, f.caller_phone, f.attribution_label, f.call_type,
       f.call_outcome, f.sentiment, f.call_duration_seconds,
       f.callback_requested, f.escalation_requested, f.resolution_state`;

export interface ListCallsOpts {
  category?: string; search?: string; from?: Date; to?: Date; limit?: number; offset?: number;
  attribution?: string; outcome?: string; sentiment?: string; resolution?: string;
  callbackRequested?: boolean; escalationRequested?: boolean;
  sort?: string; sortDir?: 'asc' | 'desc';
}

export async function listCalls(pool: pg.Pool, tenantId: string, opts: ListCallsOpts): Promise<{ calls: CallRow[]; total: number }> {
  const where = [`m.tenant_id = $1`, `m.role = 'inbound'`];
  const params: unknown[] = [tenantId];
  const eq = (val: unknown, col: string) => { params.push(val); where.push(`${col} = $${params.length}`); };
  if (opts.category) eq(opts.category, 't.category');
  if (opts.search) { params.push('%' + opts.search + '%'); where.push(`m.content ILIKE $${params.length}`); }
  if (opts.from) { params.push(opts.from); where.push(`m.created_at >= $${params.length}`); }
  if (opts.to) { params.push(opts.to); where.push(`m.created_at < $${params.length}`); }
  if (opts.attribution) eq(opts.attribution, 'f.attribution_label');
  if (opts.outcome) eq(opts.outcome, 'f.call_outcome');
  if (opts.sentiment) eq(opts.sentiment, 'f.sentiment');
  if (opts.resolution) eq(opts.resolution, 'f.resolution_state');
  if (opts.callbackRequested !== undefined) eq(opts.callbackRequested, 'f.callback_requested');
  if (opts.escalationRequested !== undefined) eq(opts.escalationRequested, 'f.escalation_requested');
  const whereSql = where.join(' AND ');
  const totalR = await pool.query<{ n: string }>(`SELECT count(*)::text n FROM ${CALL_FROM} WHERE ${whereSql}`, params);
  const sortCol = SORT_COLUMNS[opts.sort ?? 'created_at'] ?? 'm.created_at';
  const dir = opts.sortDir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  params.push(limit); const limIdx = params.length;
  params.push(offset); const offIdx = params.length;
  const r = await pool.query<CallRow>(
    `SELECT ${CALL_COLS} FROM ${CALL_FROM} WHERE ${whereSql}
      ORDER BY ${sortCol} ${dir} NULLS LAST, m.created_at DESC
      LIMIT $${limIdx} OFFSET $${offIdx}`, params);
  return { calls: r.rows, total: Number(totalR.rows[0].n) };
}

export async function getCall(pool: pg.Pool, tenantId: string, id: string): Promise<CallRow | null> {
  const r = await pool.query<CallRow>(
    `SELECT ${CALL_COLS} FROM ${CALL_FROM} WHERE m.tenant_id = $1 AND m.id = $2 AND m.role = 'inbound'`, [tenantId, id]);
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

export async function searchEmails(
  pool: pg.Pool,
  tenantId: string,
  opts: { text?: string; start: Date; end: Date; limit?: number },
): Promise<{ count: number; examples: Array<{ subject: string; excerpt: string; sent_at: Date | null }> }> {
  const where = [`tenant_id = $1`, `status = 'sent'`, `created_at >= $2`, `created_at < $3`];
  const params: unknown[] = [tenantId, opts.start, opts.end];
  if (opts.text) {
    params.push('%' + opts.text + '%');
    where.push(`(subject ILIKE $${params.length} OR COALESCE(body_text, body_html) ILIKE $${params.length})`);
  }
  const w = where.join(' AND ');
  const c = await pool.query<{ n: string }>(`SELECT count(*)::text n FROM emails WHERE ${w}`, params);
  params.push(Math.min(Math.max(opts.limit ?? 5, 1), 20));
  const r = await pool.query<{ subject: string; body: string | null; sent_at: Date | null }>(
    `SELECT subject, COALESCE(body_text, regexp_replace(body_html, '<[^>]+>', ' ', 'g')) AS body, sent_at
       FROM emails WHERE ${w} ORDER BY created_at DESC LIMIT $${params.length}`, params);
  return {
    count: Number(c.rows[0].n),
    examples: r.rows.map(x => ({ subject: x.subject, excerpt: (x.body ?? '').replace(/\s+/g, ' ').slice(0, 180), sent_at: x.sent_at })),
  };
}

export interface CallSummary {
  total: number; resolved: number; resolutionRatePct: number;
  fcrCount: number; callbackCount: number; escalationCount: number; avgDurationSeconds: number;
  sentimentMix: { positive: number; neutral: number; negative: number; unknown: number };
}
export async function callAnalyticsSummary(pool: pg.Pool, tenantId: string, start: Date, end: Date): Promise<CallSummary> {
  const r = await pool.query<Record<string, string>>(
    `SELECT count(*)::text total,
            count(*) FILTER (WHERE f.resolution_state = 'resolved')::text resolved,
            count(*) FILTER (WHERE f.fcr IS TRUE)::text fcr,
            count(*) FILTER (WHERE f.callback_requested IS TRUE)::text callback,
            count(*) FILTER (WHERE f.escalation_requested IS TRUE)::text escalation,
            COALESCE(round(avg(f.call_duration_seconds))::int, 0)::text avg_duration,
            count(*) FILTER (WHERE f.sentiment = 'positive')::text s_pos,
            count(*) FILTER (WHERE f.sentiment = 'neutral')::text s_neu,
            count(*) FILTER (WHERE f.sentiment = 'negative')::text s_neg,
            count(*) FILTER (WHERE f.sentiment IS NULL)::text s_unk
       FROM agent_messages m LEFT JOIN call_facts f ON f.message_id = m.id
      WHERE m.tenant_id = $1 AND m.role = 'inbound' AND m.created_at >= $2 AND m.created_at < $3`,
    [tenantId, start, end]);
  const x = r.rows[0]; const total = Number(x.total); const resolved = Number(x.resolved);
  return {
    total, resolved,
    resolutionRatePct: total ? Math.round((resolved / total) * 100) : 0,
    fcrCount: Number(x.fcr), callbackCount: Number(x.callback), escalationCount: Number(x.escalation),
    avgDurationSeconds: Number(x.avg_duration),
    sentimentMix: { positive: Number(x.s_pos), neutral: Number(x.s_neu), negative: Number(x.s_neg), unknown: Number(x.s_unk) },
  };
}

export async function breakdownBy(pool: pg.Pool, tenantId: string, dimension: string, start: Date, end: Date): Promise<Array<{ key: string | null; count: number }>> {
  const col = BREAKDOWN_COLUMNS[dimension];
  if (!col) throw new Error(`invalid breakdown dimension: ${dimension}`);
  const r = await pool.query<{ key: string | null; count: string }>(
    `SELECT ${col} AS key, count(*)::text count
       FROM agent_messages m
       LEFT JOIN call_facts f     ON f.message_id = m.id
       LEFT JOIN line_call_tags t ON t.message_id = m.id
      WHERE m.tenant_id = $1 AND m.role = 'inbound' AND m.created_at >= $2 AND m.created_at < $3
      GROUP BY 1 ORDER BY count(*) DESC`, [tenantId, start, end]);
  return r.rows.map(x => ({ key: x.key, count: Number(x.count) }));
}

export async function crosstabDeptCategory(pool: pg.Pool, tenantId: string, start: Date, end: Date): Promise<Array<{ attribution_label: string | null; category: string | null; count: number }>> {
  const r = await pool.query<{ attribution_label: string | null; category: string | null; count: string }>(
    `SELECT f.attribution_label, t.category, count(*)::text count
       FROM agent_messages m
       LEFT JOIN call_facts f     ON f.message_id = m.id
       LEFT JOIN line_call_tags t ON t.message_id = m.id
      WHERE m.tenant_id = $1 AND m.role = 'inbound' AND m.created_at >= $2 AND m.created_at < $3
      GROUP BY 1, 2 ORDER BY count(*) DESC`, [tenantId, start, end]);
  return r.rows.map(x => ({ attribution_label: x.attribution_label, category: x.category, count: Number(x.count) }));
}
