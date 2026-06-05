import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { backfillCallFactsForTenant } from '../src/agent/abe/backfillCalls.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function seedInbound(tenantId: string, ref: string, content: string): Promise<string> {
  const th = await pool.query<{ id: string }>(
    `INSERT INTO agent_threads (tenant_id, jobix_thread_ref) VALUES ($1,$2) RETURNING id`, [tenantId, `t:${ref}`]);
  const m = await pool.query<{ id: string }>(
    `INSERT INTO agent_messages (thread_id, tenant_id, role, source, content, status, message_ref)
     VALUES ($1,$2,'inbound','jobix',$3,'sent',$4) RETURNING id`, [th.rows[0].id, tenantId, content, ref]);
  return m.rows[0].id;
}

describe('backfillCallFactsForTenant', () => {
  it('creates a facts row for messages lacking one, idempotently', async () => {
    const t = await createTenant(pool);
    const m1 = await seedInbound(t.id, 'r1', 'old call about arrears');

    const n1 = await backfillCallFactsForTenant(pool, t.id);
    expect(n1).toBe(1);
    const f = await pool.query(`SELECT summary, resolution_state FROM call_facts WHERE message_id=$1`, [m1]);
    expect(f.rows[0].summary).toBe('old call about arrears');
    expect(f.rows[0].resolution_state).toBe('open');

    const n2 = await backfillCallFactsForTenant(pool, t.id);
    expect(n2).toBe(0); // idempotent
  });
});
