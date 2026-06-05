import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { breakdownBy, crosstabDeptCategory } from '../src/repos/callAnalytics.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function seed(tenantId: string, attribution: string | null, category: string | null) {
  const th = await pool.query<{ id: string }>(`INSERT INTO agent_threads (tenant_id, jobix_thread_ref) VALUES ($1,'jobix:'||gen_random_uuid()) RETURNING id`, [tenantId]);
  const m = await pool.query<{ id: string }>(`INSERT INTO agent_messages (thread_id, tenant_id, role, source, content, status) VALUES ($1,$2,'inbound','jobix','x','sent') RETURNING id`, [th.rows[0].id, tenantId]);
  await pool.query(`INSERT INTO call_facts (tenant_id, message_id, attribution_label) VALUES ($1,$2,$3)`, [tenantId, m.rows[0].id, attribution]);
  if (category) await pool.query(`INSERT INTO line_call_tags (tenant_id, message_id, category, severity) VALUES ($1,$2,$3,'low')`, [tenantId, m.rows[0].id, category]);
}
const W = [new Date('2000-01-01'), new Date('2999-01-01')] as const;

describe('breakdownBy + crosstab', () => {
  it('groups by an allow-listed dimension and rejects others', async () => {
    const t = await createTenant(pool);
    await seed(t.id, 'Accounts', 'Arrears'); await seed(t.id, 'Accounts', 'Arrears'); await seed(t.id, 'Maintenance', 'Leak');
    const byDept = await breakdownBy(pool, t.id, 'attribution_label', W[0], W[1]);
    expect(byDept).toEqual([{ key: 'Accounts', count: 2 }, { key: 'Maintenance', count: 1 }]);
    await expect(breakdownBy(pool, t.id, 'evil_col' as never, W[0], W[1])).rejects.toThrow();
  });
  it('crosstab returns dept x category counts', async () => {
    const t = await createTenant(pool);
    await seed(t.id, 'Accounts', 'Arrears'); await seed(t.id, 'Accounts', 'Arrears'); await seed(t.id, 'Maintenance', 'Leak');
    const x = await crosstabDeptCategory(pool, t.id, W[0], W[1]);
    expect(x).toContainEqual({ attribution_label: 'Accounts', category: 'Arrears', count: 2 });
    expect(x).toContainEqual({ attribution_label: 'Maintenance', category: 'Leak', count: 1 });
  });
});
