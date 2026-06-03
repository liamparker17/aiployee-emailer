import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { seedInboundCall } from './helpers/lineReport.js';
import { suggestCategories } from '../src/agent/abe/categorySuggest.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

it('proposes categories from a sample of call summaries', async () => {
  const t = await createTenant(pool);
  await seedInboundCall(pool, t.id, 'policy renewal question');
  await seedInboundCall(pool, t.id, 'claim for hail damage');
  const stub = { chat: async () => ({ content: JSON.stringify({ categories: ['Policy queries', 'Claims', 'General enquiries'] }) }) };
  const cats = await suggestCategories({ pool, tenantId: t.id, llm: stub as any, model: 'gpt-4o', sample: 20 });
  expect(cats).toEqual(['Policy queries', 'Claims', 'General enquiries']);
});

it('returns [] when there are no calls', async () => {
  const t = await createTenant(pool);
  const stub = { chat: async () => ({ content: '{"categories":[]}' }) };
  expect(await suggestCategories({ pool, tenantId: t.id, llm: stub as any, model: 'gpt-4o' })).toEqual([]);
});
