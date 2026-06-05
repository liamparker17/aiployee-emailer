import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { ingestJobixCall } from '../src/agent/abe/ingestCall.js';
import { getCallFactsByMessage } from '../src/repos/callFacts.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

const body = {
  customer_data: {
    main: { suid: 's1', name: 'Renier', phone: '+27', timezone: 'Africa/Johannesburg' },
    values: { type: 'Seller', call_summary: 'wants to sell', call_outcome: 'completed' },
  },
};

describe('ingestJobixCall', () => {
  it('creates one inbound message + call_facts, idempotent on callRef', async () => {
    const t = await createTenant(pool);

    const r1 = await ingestJobixCall({ pool, tenantId: t.id, callRef: 'call-1', body, attribution: {} });
    expect(r1.created).toBe(true);

    const msg = await pool.query(
      `SELECT id, content, role, source FROM agent_messages WHERE tenant_id=$1 AND message_ref='call-1'`, [t.id]);
    expect(msg.rowCount).toBe(1);
    expect(msg.rows[0].role).toBe('inbound');
    expect(msg.rows[0].source).toBe('jobix');
    expect(msg.rows[0].content).toBe('wants to sell');

    const f = await getCallFactsByMessage(pool, msg.rows[0].id);
    expect(f?.caller_suid).toBe('s1');
    expect(f?.attribution_label).toBe('Seller');
    expect(f?.call_outcome).toBe('completed');

    const r2 = await ingestJobixCall({ pool, tenantId: t.id, callRef: 'call-1', body, attribution: {} });
    expect(r2.created).toBe(false);
    const cnt = await pool.query(`SELECT COUNT(*)::int AS n FROM agent_messages WHERE tenant_id=$1`, [t.id]);
    expect(cnt.rows[0].n).toBe(1);
  });

  it('falls back to subject/summary when no call_summary, never empty content', async () => {
    const t = await createTenant(pool);
    await ingestJobixCall({
      pool, tenantId: t.id, callRef: 'call-2',
      body: { customer_data: { main: { suid: 's2' }, values: { context: 'abandoned deposit' } } },
      attribution: {},
    });
    const msg = await pool.query(
      `SELECT content FROM agent_messages WHERE tenant_id=$1 AND message_ref='call-2'`, [t.id]);
    expect(msg.rows[0].content.length).toBeGreaterThan(0);
  });
});
