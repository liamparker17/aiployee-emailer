import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { getLineReportConfig, upsertLineReportConfig } from '../src/repos/lineReportConfigs.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('lineReportConfigs repo', () => {
  it('returns null when none', async () => {
    const t = await createTenant(pool);
    expect(await getLineReportConfig(pool, t.id)).toBeNull();
  });

  it('upserts, clamps bounds, validates recipients', async () => {
    const t = await createTenant(pool);
    const c = await upsertLineReportConfig(pool, t.id, {
      enabled: true, spikePct: 9999, spikeMinCount: 0, baselinePeriods: 99,
      recipients: ['ops@absa.co.za', 'not-an-email'],
    });
    expect(c.enabled).toBe(true);
    expect(c.spike_pct).toBe(500);
    expect(c.spike_min_count).toBe(1);
    expect(c.baseline_periods).toBe(12);
    expect(c.recipients).toEqual(['ops@absa.co.za']);
  });

  it('sparse patch preserves omitted fields', async () => {
    const t = await createTenant(pool);
    await upsertLineReportConfig(pool, t.id, { spikePct: 30 });
    const c = await upsertLineReportConfig(pool, t.id, { enabled: true });
    expect(c.spike_pct).toBe(30);
    expect(c.enabled).toBe(true);
  });

  it('round-trips attribution_map', async () => {
    const t = await createTenant(pool);
    await upsertLineReportConfig(pool, t.id, { attributionMap: { source: 'values_key', values_key: 'department' } });
    const cfg = await getLineReportConfig(pool, t.id);
    expect(cfg?.attribution_map).toEqual({ source: 'values_key', values_key: 'department' });
  });
});
