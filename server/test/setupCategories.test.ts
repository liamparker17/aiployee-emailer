import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { getLineReportConfig, upsertLineReportConfig } from '../src/repos/lineReportConfigs.js';
import { mirrorEmailAsCall } from '../src/agent/abe/mirrorCall.js';
import { applyCategories, setupCategories, ensureCategories } from '../src/agent/abe/setupCategories.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

// suggestCategories' prompt contains "propose ... CATEGORY names"; lineTagger's prompt
// contains "category" too, so we branch on "propose" (present in suggest, absent in tag).
const stub = (cats: string[]) => ({
  chat: async (a: { messages: Array<{ content: string }> }) => {
    const text = a.messages.map(m => m.content).join(' ').toLowerCase();
    if (text.includes('propose')) return { content: JSON.stringify({ categories: cats }) };
    return { content: JSON.stringify({ tags: [] }) };
  },
});

async function seedCalls(tenantId: string, n: number) {
  for (let i = 0; i < n; i++) {
    await mirrorEmailAsCall({ pool, tenantId, emailId: `e${i}-${tenantId}`, summary: `caller about claim ${i}` });
  }
}

it('applyCategories normalises, guards overwrite, and can replace', async () => {
  const t = await createTenant(pool);
  const r1 = await applyCategories(pool, t.id, ['  Claims ', 'claims', 'Policy', '']);
  expect(r1.applied).toBe(true);
  expect(r1.categories).toEqual(['Claims', 'Policy']);
  const r2 = await applyCategories(pool, t.id, ['Other']);
  expect(r2.applied).toBe(false);
  expect((await getLineReportConfig(pool, t.id))?.taxonomy).toEqual(['Claims', 'Policy']);
  const r3 = await applyCategories(pool, t.id, ['Other'], { replace: true });
  expect(r3.applied).toBe(true);
  expect((await getLineReportConfig(pool, t.id))?.taxonomy).toEqual(['Other']);
});

it('setupCategories derives from calls, applies, and tags', async () => {
  const t = await createTenant(pool);
  await seedCalls(t.id, 3);
  const r = await setupCategories({ pool, tenantId: t.id, llm: stub(['Claims', 'Policy', 'Complaints']) as any, model: 'gpt-4o' });
  expect(r.applied).toBe(true);
  expect(r.categories).toEqual(['Claims', 'Policy', 'Complaints']);
  expect(typeof r.tagged).toBe('number');
  expect((await getLineReportConfig(pool, t.id))?.taxonomy).toEqual(['Claims', 'Policy', 'Complaints']);
});

it('ensureCategories applies only when empty + has calls; no-op otherwise', async () => {
  const t = await createTenant(pool);
  expect(await ensureCategories({ pool, tenantId: t.id, llm: stub(['X']) as any, model: 'gpt-4o' })).toEqual([]);
  expect(await getLineReportConfig(pool, t.id)).toBeNull();
  await seedCalls(t.id, 2);
  const cats = await ensureCategories({ pool, tenantId: t.id, llm: stub(['Claims', 'Policy']) as any, model: 'gpt-4o' });
  expect(cats).toEqual(['Claims', 'Policy']);
  const again = await ensureCategories({ pool, tenantId: t.id, llm: stub(['Totally', 'Different']) as any, model: 'gpt-4o' });
  expect(again).toEqual(['Claims', 'Policy']);
});
