import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { seedInboundCall } from './helpers/lineReport.js';
import { makeLineChatProvider } from '../src/agent/abe/lineChatTools.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

it('search_calls counts calls whose summary matches the text', async () => {
  const t = await createTenant(pool);
  await seedInboundCall(pool, t.id, 'caller wants to cancel their policy');
  await seedInboundCall(pool, t.id, 'general enquiry about branch hours');
  const p = makeLineChatProvider({ pool, tenantId: t.id });
  const out = JSON.parse(await p.callTool('search_calls', { text: 'cancel', windowDays: 30 }));
  expect(out.count).toBe(1);
  const names = (await p.listTools()).map(tl => tl.name);
  expect(names).toContain('search_calls');
});
