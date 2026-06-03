import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { seedInboundCall } from './helpers/lineReport.js';
import { upsertLineReportConfig } from '../src/repos/lineReportConfigs.js';
import { insertCallTag } from '../src/repos/lineCallTags.js';
import { breakdownByCategory } from '../src/repos/callAnalytics.js';
import { retagCalls } from '../src/agent/abe/retag.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

it('clears old tags and re-tags into the current taxonomy', async () => {
  const t = await createTenant(pool);
  await upsertLineReportConfig(pool, t.id, { enabled: true, taxonomy: ['Policy queries', 'Claims', 'Other / Emerging'] });
  const m = await seedInboundCall(pool, t.id, 'claim for storm damage');
  await insertCallTag(pool, { tenantId: t.id, messageId: m.id, category: 'Card disputes / fraud', severity: 'low', isEmerging: false });

  const stub = { chat: async () => ({ content: JSON.stringify({ tags: [{ ref: 1, category: 'Claims', severity: 'med', is_emerging: false }] }) }) };
  const res = await retagCalls({ pool, tenantId: t.id, llm: stub as any, model: 'gpt-4o' });
  expect(res.retagged).toBe(1);
  expect(res.remaining).toBe(0);
  const start = new Date(0), end = new Date(Date.now() + 1000);
  const bd = await breakdownByCategory(pool, t.id, start, end);
  expect(bd.find(b => b.category === 'Claims')?.count).toBe(1);
  expect(bd.find(b => b.category === 'Card disputes / fraud')).toBeUndefined();
});
