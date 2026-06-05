import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { ingestJobixCall } from '../src/agent/abe/ingestCall.js';
import { mirrorEmailAsCall } from '../src/agent/abe/mirrorCall.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('calls view', () => {
  it('returns both webhook calls (with facts) and legacy mirror calls (no facts)', async () => {
    const t = await createTenant(pool);

    await ingestJobixCall({
      pool, tenantId: t.id, callRef: 'w1',
      body: { customer_data: { main: { suid: 's1' }, values: { type: 'Seller', call_summary: 'webhook call' } } },
      attribution: {},
    });
    await mirrorEmailAsCall({ pool, tenantId: t.id, emailId: 'legacy-1', summary: 'legacy mirror call' });

    const r = await pool.query(
      `SELECT summary_text, attribution_label, call_type FROM calls WHERE tenant_id=$1 ORDER BY summary_text`, [t.id]);
    expect(r.rowCount).toBe(2);
    // legacy row: no facts -> attribution_label is null but the call still appears
    const legacy = r.rows.find(x => x.summary_text === 'legacy mirror call');
    expect(legacy).toBeTruthy();
    expect(legacy.attribution_label).toBeNull();
    // webhook row: facts present
    const wh = r.rows.find(x => x.summary_text === 'webhook call');
    expect(wh.call_type).toBe('Seller');
  });
});
