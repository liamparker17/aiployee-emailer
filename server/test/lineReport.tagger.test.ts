import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { seedInboundCall } from './helpers/lineReport.js';
import { upsertLineReportConfig } from '../src/repos/lineReportConfigs.js';
import { aggregateByCategory } from '../src/repos/lineCallTags.js';
import { tagNewCalls } from '../src/agent/abe/lineTagger.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

it('tags untagged inbound calls into the taxonomy, once', async () => {
  const t = await createTenant(pool);
  await upsertLineReportConfig(pool, t.id, { enabled: true });
  const m1 = await seedInboundCall(pool, t.id, 'fraud on my card');
  await seedInboundCall(pool, t.id, 'app keeps crashing');

  const stubLlm = { chat: async () => ({ content: JSON.stringify({ tags: [
    { ref: 1, category: 'Card disputes / fraud', severity: 'high', is_emerging: false },
    { ref: 2, category: 'Online & app banking', severity: 'low', is_emerging: false },
  ] }) }) };

  const n = await tagNewCalls({ pool, tenantId: t.id, llm: stubLlm as any, model: 'gpt-4o', batch: 50 });
  expect(n).toBe(2);
  const agg = await aggregateByCategory(pool, t.id, new Date(0), new Date(Date.now() + 1000));
  expect(agg.find(a => a.category === 'Card disputes / fraud')?.count).toBe(1);

  const n2 = await tagNewCalls({ pool, tenantId: t.id, llm: stubLlm as any, model: 'gpt-4o', batch: 50 });
  expect(n2).toBe(0);
});

it('maps an unknown category to the fallback bucket with is_emerging', async () => {
  const t = await createTenant(pool);
  await upsertLineReportConfig(pool, t.id, { enabled: true });
  await seedInboundCall(pool, t.id, 'something totally novel');
  const stubLlm = { chat: async () => ({ content: JSON.stringify({ tags: [
    { ref: 1, category: 'Not A Real Category', severity: 'low', is_emerging: false },
  ] }) }) };
  const n = await tagNewCalls({ pool, tenantId: t.id, llm: stubLlm as any, model: 'gpt-4o', batch: 50 });
  expect(n).toBe(1);
  const agg = await aggregateByCategory(pool, t.id, new Date(0), new Date(Date.now() + 1000));
  expect(agg.find(a => a.category === 'Other / Emerging')?.count).toBe(1);
});
