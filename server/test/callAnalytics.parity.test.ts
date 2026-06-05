import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { listCalls, callAnalyticsSummary } from '../src/repos/callAnalytics.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function inbound(tenantId: string, content: string): Promise<string> {
  const th = await pool.query<{ id: string }>(`INSERT INTO agent_threads (tenant_id, jobix_thread_ref) VALUES ($1,'jobix:'||gen_random_uuid()) RETURNING id`, [tenantId]);
  const m = await pool.query<{ id: string }>(`INSERT INTO agent_messages (thread_id, tenant_id, role, source, content, status) VALUES ($1,$2,'inbound','jobix',$3,'sent') RETURNING id`, [th.rows[0].id, tenantId, content]);
  return m.rows[0].id;
}

describe('scope parity — calls without call_facts still listed/aggregated', () => {
  it('LEFT JOIN keeps legacy (no facts) + webhook (with facts) calls', async () => {
    const t = await createTenant(pool);
    // legacy: inbound message with NO call_facts row
    await inbound(t.id, 'legacy mirror call');
    // webhook: inbound message WITH a call_facts row
    const wid = await inbound(t.id, 'webhook call');
    await pool.query(`INSERT INTO call_facts (tenant_id, message_id, attribution_label, resolution_state) VALUES ($1,$2,'Accounts','resolved')`, [t.id, wid]);

    const list = await listCalls(pool, t.id, {});
    expect(list.total).toBe(2);
    const legacy = list.calls.find(c => c.content === 'legacy mirror call');
    expect(legacy).toBeTruthy();
    expect(legacy!.attribution_label).toBeNull(); // no facts -> null, but still present

    const s = await callAnalyticsSummary(pool, t.id, new Date('2000-01-01'), new Date('2999-01-01'));
    expect(s.total).toBe(2);     // both counted
    expect(s.resolved).toBe(1);  // only the webhook call is resolved
  });
});
