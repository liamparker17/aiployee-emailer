import type pg from 'pg';
import { deleteTagsForTenant } from '../../repos/callAnalytics.js';
import { tagNewCalls } from './lineTagger.js';

interface LlmLike { chat(a: { model: string; messages: Array<{ role: string; content: string }> }): Promise<{ content: string }>; }

export async function retagCalls(args: {
  pool: pg.Pool; tenantId: string; llm: LlmLike; model: string; cap?: number;
}): Promise<{ retagged: number; remaining: number }> {
  const { pool, tenantId, llm, model } = args;
  await deleteTagsForTenant(pool, tenantId);
  const max = args.cap ?? 500;
  let retagged = 0;
  while (retagged < max) {
    const n = await tagNewCalls({ pool, tenantId, llm, model, batch: 50 });
    if (n === 0) break;
    retagged += n;
  }
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text n FROM agent_messages m
       LEFT JOIN line_call_tags t ON t.message_id = m.id
      WHERE m.tenant_id = $1 AND m.role = 'inbound' AND t.id IS NULL`, [tenantId]);
  return { retagged, remaining: Number(r.rows[0].n) };
}
