import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { getLineReportConfig, upsertLineReportConfig } from '../src/repos/lineReportConfigs.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

it('ingest_sends_as_calls round-trips (default false)', async () => {
  const t = await createTenant(pool);
  const c1 = await upsertLineReportConfig(pool, t.id, { enabled: true });
  expect(c1.ingest_sends_as_calls).toBe(false);
  const c2 = await upsertLineReportConfig(pool, t.id, { ingestSendsAsCalls: true });
  expect(c2.ingest_sends_as_calls).toBe(true);
  expect((await getLineReportConfig(pool, t.id))?.ingest_sends_as_calls).toBe(true);
});
