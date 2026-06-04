import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { getLineReportConfig } from '../src/repos/lineReportConfigs.js';
import { mirrorEmailAsCall } from '../src/agent/abe/mirrorCall.js';
import { backfillCallsFromEmails } from '../src/agent/abe/backfillCalls.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

const stub = (cats: string[]) => ({
  chat: async (a: { messages: Array<{ content: string }> }) => {
    const text = a.messages.map(m => m.content).join(' ').toLowerCase();
    if (text.includes('propose')) return { content: JSON.stringify({ categories: cats }) };
    return { content: JSON.stringify({ tags: [] }) };
  },
});

it('backfill auto-creates categories for an empty-taxonomy tenant', async () => {
  const t = await createTenant(pool);
  await mirrorEmailAsCall({ pool, tenantId: t.id, emailId: 'e1', summary: 'caller about a claim' });
  await backfillCallsFromEmails({ pool, tenantId: t.id, llm: stub(['Claims', 'Policy']) as any, model: 'gpt-4o' });
  expect((await getLineReportConfig(pool, t.id))?.taxonomy).toEqual(['Claims', 'Policy']);
});
