import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { seedInboundCall } from './helpers/lineReport.js';
import { upsertLineReportConfig } from '../src/repos/lineReportConfigs.js';
import { insertCallTag } from '../src/repos/lineCallTags.js';
import { makeLineChatProvider } from '../src/agent/abe/lineChatTools.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

it('top_call_reasons returns ranked categories', async () => {
  const t = await createTenant(pool);
  await upsertLineReportConfig(pool, t.id, { enabled: true });
  const m = await seedInboundCall(pool, t.id, 'fraud');
  await insertCallTag(pool, { tenantId: t.id, messageId: m.id, category: 'Card disputes / fraud', severity: 'high', isEmerging: false });
  const p = makeLineChatProvider({ pool, tenantId: t.id });
  const out = JSON.parse(await p.callTool('top_call_reasons', { windowDays: 7 }));
  expect(out[0]).toMatchObject({ category: 'Card disputes / fraud', count: 1 });
});

it('exposes NO send/execute tool (structural gate)', async () => {
  const p = makeLineChatProvider({ pool, tenantId: 'x' });
  const names = (await p.listTools()).map(t => t.name);
  expect(names).not.toContain('send');
  expect(names).not.toContain('execute_play');
  expect(names.some(n => /send|dispatch|email/i.test(n))).toBe(false);
});
