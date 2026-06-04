import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { upsertLineReportConfig } from '../src/repos/lineReportConfigs.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

it('a new config has NO default categories (empty taxonomy)', async () => {
  const t = await createTenant(pool);
  const c = await upsertLineReportConfig(pool, t.id, { enabled: true });
  expect(c.taxonomy).toEqual([]);
});
