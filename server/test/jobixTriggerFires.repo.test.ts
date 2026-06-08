import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createTrigger, recordFire, listFires, touchLastFired, getTriggerForFire } from '../src/repos/jobixTriggers.js';

const KEY = Buffer.alloc(32, 9);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function trig(tenantId: string) {
  return createTrigger(pool, KEY, { tenantId, label: 'L', token: 'k', tokenPlacement: 'bearer', payloadTemplate: '{}' });
}

describe('jobixTriggers repo — fire log', () => {
  it('records fires and lists them newest-first, scoped to tenant+trigger', async () => {
    const t = await createTenant(pool); const tr = await trig(t.id);
    await recordFire(pool, { tenantId: t.id, triggerId: tr.id, source: 'manual', vars: { name: 'R' }, httpStatus: 200, ok: true, responseSnippet: 'accepted', error: null, createdBy: null });
    await recordFire(pool, { tenantId: t.id, triggerId: tr.id, source: 'test', vars: {}, httpStatus: 500, ok: false, responseSnippet: null, error: 'HTTP 500', createdBy: null });
    const { fires, total } = await listFires(pool, t.id, tr.id, {});
    expect(total).toBe(2);
    expect(fires).toHaveLength(2);
    expect(fires[0].source).toBe('test'); // newest first
    expect(fires[0].ok).toBe(false);
  });

  it('touchLastFired sets last_fired_at', async () => {
    const t = await createTenant(pool); const tr = await trig(t.id);
    await touchLastFired(pool, t.id, tr.id);
    const f = await getTriggerForFire(pool, KEY, t.id, tr.id);
    expect(f).toBeTruthy();
    const row = await pool.query(`SELECT last_fired_at FROM jobix_triggers WHERE id = $1`, [tr.id]);
    expect(row.rows[0].last_fired_at).not.toBeNull();
  });
});
