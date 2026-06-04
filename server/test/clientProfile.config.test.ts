import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { getLineReportConfig, upsertLineReportConfig } from '../src/repos/lineReportConfigs.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

it('client_name/client_context round-trip and default null', async () => {
  const t = await createTenant(pool);
  const c1 = await upsertLineReportConfig(pool, t.id, { enabled: true });
  expect(c1.client_name).toBeNull();
  expect(c1.client_context).toBeNull();
  const c2 = await upsertLineReportConfig(pool, t.id, { clientName: 'ABSA', clientContext: 'iDirect overflow line' });
  expect(c2.client_name).toBe('ABSA');
  expect(c2.client_context).toBe('iDirect overflow line');
  const c3 = await upsertLineReportConfig(pool, t.id, { enabled: false });   // unrelated patch preserves (mirror brand_voice)
  expect(c3.client_name).toBe('ABSA');
  expect((await getLineReportConfig(pool, t.id))?.client_context).toBe('iDirect overflow line');
});
