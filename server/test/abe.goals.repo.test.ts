import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { getGoal, upsertGoal, listEnabledGoals } from '../src/repos/agentGoals.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('agentGoals repo', () => {
  it('upserts and reads a goal, defaults auto_fire_max_audience to 0', async () => {
    const t = await createTenant(pool);
    const g = await upsertGoal(pool, t.id, { enabled: true, dormantWindowDays: 45 });
    expect(g.enabled).toBe(true);
    expect(g.dormant_window_days).toBe(45);
    expect(g.auto_fire_max_audience).toBe(0);
    const again = await getGoal(pool, t.id);
    expect(again?.id).toBe(g.id); // upsert is idempotent per (tenant, kind)
  });

  it('upsert update path preserves fields omitted from the patch', async () => {
    const t = await createTenant(pool);
    await upsertGoal(pool, t.id, { enabled: true, dormantWindowDays: 60 });
    const updated = await upsertGoal(pool, t.id, { dormantWindowDays: 30 });
    expect(updated.dormant_window_days).toBe(30); // changed field applied
    expect(updated.enabled).toBe(true);           // omitted field preserved
  });

  it('listEnabledGoals returns only enabled goals across tenants', async () => {
    const a = await createTenant(pool);
    const b = await createTenant(pool);
    await upsertGoal(pool, a.id, { enabled: true });
    await upsertGoal(pool, b.id, { enabled: false });
    const enabled = await listEnabledGoals(pool);
    expect(enabled.map(g => g.tenant_id)).toEqual([a.id]);
  });
});
