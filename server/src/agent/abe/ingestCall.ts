import type pg from 'pg';
import { normalizeCall, type AttributionMap } from './jobixPayload.js';
import { upsertCallFacts } from '../../repos/callFacts.js';

// Ingest one Jobix post-call payload. Creates the human-readable inbound message
// (same shape existing Abe readers expect) + the structured call_facts row.
// Idempotent on (tenant_id, message_ref = callRef). Returns created=false on re-delivery
// but still refreshes call_facts so corrections land.
export async function ingestJobixCall(args: {
  pool: pg.Pool; tenantId: string; callRef: string;
  body: unknown; attribution: AttributionMap; lineRef?: string | null;
}): Promise<{ created: boolean; messageId: string }> {
  const n = normalizeCall(args.body, args.attribution, args.lineRef);
  // content must never be empty (agent_messages.content is NOT NULL and readers expect text).
  const content = n.summary ?? n.callType ?? n.attributionLabel ?? 'Inbound call';

  const th = await args.pool.query<{ id: string }>(
    `INSERT INTO agent_threads (tenant_id, jobix_thread_ref)
       VALUES ($1, $2)
       ON CONFLICT (tenant_id, jobix_thread_ref) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [args.tenantId, `jobix:${n.callerSuid ?? args.callRef}`]);

  const ins = await args.pool.query<{ id: string }>(
    `INSERT INTO agent_messages (thread_id, tenant_id, role, source, content, status, message_ref)
       VALUES ($1,$2,'inbound','jobix',$3,'sent',$4)
       ON CONFLICT (tenant_id, message_ref) WHERE message_ref IS NOT NULL DO NOTHING
     RETURNING id`,
    [th.rows[0].id, args.tenantId, content, args.callRef]);

  const created = (ins.rowCount ?? 0) > 0;
  const messageId = created
    ? ins.rows[0].id
    : (await args.pool.query<{ id: string }>(
        `SELECT id FROM agent_messages WHERE tenant_id=$1 AND message_ref=$2`,
        [args.tenantId, args.callRef])).rows[0].id;

  await upsertCallFacts(args.pool, {
    ...n, tenantId: args.tenantId, messageId,
    rawPayload: (args.body ?? {}) as Record<string, unknown>,
  });

  return { created, messageId };
}
