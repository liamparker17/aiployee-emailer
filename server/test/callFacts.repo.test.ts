import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { upsertCallFacts, getCallFactsByMessage } from '../src/repos/callFacts.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

// Minimal inbound message so the FK + unique(message_id) are real.
async function seedMessage(tenantId: string): Promise<string> {
  const th = await pool.query<{ id: string }>(
    `INSERT INTO agent_threads (tenant_id, jobix_thread_ref) VALUES ($1,'jobix:s1') RETURNING id`, [tenantId]);
  const m = await pool.query<{ id: string }>(
    `INSERT INTO agent_messages (thread_id, tenant_id, role, source, content, status, message_ref)
     VALUES ($1,$2,'inbound','jobix','hi','sent','ref1') RETURNING id`, [th.rows[0].id, tenantId]);
  return m.rows[0].id;
}

const base = {
  callerSuid: 's1', callerName: 'R', callerPhone: '+27', callerTimezone: 'Africa/Johannesburg',
  lineRef: 'agentA', attributionLabel: 'Seller', callType: 'Seller', summary: 'hi',
  callOutcome: 'completed', sentiment: 'positive', callDurationSeconds: 222,
  callbackRequested: false, callbackPreferredTime: null, escalationRequested: false,
  values: { type: 'Seller' }, rawPayload: { ok: true },
};

describe('callFacts repo', () => {
  it('inserts then upserts on the same message (no duplicate)', async () => {
    const t = await createTenant(pool);
    const messageId = await seedMessage(t.id);

    await upsertCallFacts(pool, { tenantId: t.id, messageId, ...base });
    let f = await getCallFactsByMessage(pool, messageId);
    expect(f?.caller_suid).toBe('s1');
    expect(f?.call_duration_seconds).toBe(222);
    expect(f?.resolution_state).toBe('open');

    await upsertCallFacts(pool, { tenantId: t.id, messageId, ...base, summary: 'updated', callOutcome: 'escalated' });
    f = await getCallFactsByMessage(pool, messageId);
    expect(f?.summary).toBe('updated');
    expect(f?.call_outcome).toBe('escalated');

    const cnt = await pool.query(`SELECT COUNT(*)::int AS n FROM call_facts WHERE message_id=$1`, [messageId]);
    expect(cnt.rows[0].n).toBe(1);
  });
});
