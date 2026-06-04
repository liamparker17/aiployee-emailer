import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { getLineReportConfig } from '../src/repos/lineReportConfigs.js';
import { makeLineChatProvider } from '../src/agent/abe/lineChatTools.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

const stub = { chat: async () => ({ content: JSON.stringify({ tags: [] }) }) };

it('setup_categories is advertised and applies a passed list', async () => {
  const t = await createTenant(pool);
  const p = makeLineChatProvider({ pool, tenantId: t.id, llm: stub as any, model: 'gpt-4o' });
  expect((await p.listTools()).map((x: { name: string }) => x.name)).toContain('setup_categories');
  const out = JSON.parse(await p.callTool('setup_categories', { categories: ['Claims', 'Policy'] }));
  expect(out.applied).toBe(true);
  expect(out.categories).toEqual(['Claims', 'Policy']);
  expect((await getLineReportConfig(pool, t.id))?.taxonomy).toEqual(['Claims', 'Policy']);
});

it('setup_categories returns a friendly error when no LLM is configured', async () => {
  const t = await createTenant(pool);
  const p = makeLineChatProvider({ pool, tenantId: t.id }); // no llm/model
  const out = JSON.parse(await p.callTool('setup_categories', { categories: ['X'] }));
  expect(out.error).toMatch(/openai/i);
});
