import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { seedInboundCall } from './helpers/lineReport.js';
import { upsertLineReportConfig } from '../src/repos/lineReportConfigs.js';
import { tagNewCalls } from '../src/agent/abe/lineTagger.js';
import { composeDigest } from '../src/agent/abe/lineCompose.js';
import { buildAbeSystemPrompt } from '../src/agent/abe/prompt.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

function capStub(reply: object) {
  const seen: string[] = [];
  return { seen, llm: { chat: async (a: { messages: Array<{ role: string; content: string }> }) => { seen.push(a.messages.map(m => m.content).join('\n')); return { content: JSON.stringify(reply) }; } } };
}

it('tagger prompt is de-banked (no "bank client")', async () => {
  const t = await createTenant(pool);
  await upsertLineReportConfig(pool, t.id, { enabled: true, taxonomy: ['Claims'] });
  await seedInboundCall(pool, t.id, 'a claim');
  const s = capStub({ tags: [] });
  await tagNewCalls({ pool, tenantId: t.id, llm: s.llm as any, model: 'gpt-4o', batch: 10 });
  expect(s.seen.join(' ')).not.toMatch(/bank client/i);
});

it('buildAbeSystemPrompt injects the client when set, generic otherwise', () => {
  const withClient = buildAbeSystemPrompt('', 'ABSA', 'iDirect overflow');
  expect(withClient).toContain('ABSA');
  expect(withClient).toContain('iDirect overflow');
  expect(buildAbeSystemPrompt('')).not.toContain('ABSA');
});

it('composeDigest threads client_name into the prompt; generic fallback otherwise', async () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const end = new Date('2026-01-02T00:00:00Z');

  // With client_name set → prompt mentions the client by name.
  const t1 = await createTenant(pool);
  await upsertLineReportConfig(pool, t1.id, { enabled: true, taxonomy: ['Claims'], clientName: 'ABSA' });
  const s1 = capStub({ subject: 's', body: 'b' });
  await composeDigest({ pool, tenantId: t1.id, llm: s1.llm as any, model: 'gpt-4o', periodLabel: 'daily', start, end });
  expect(s1.seen.join(' ')).toContain('ABSA');

  // Without client_name → generic "the client", never "ABSA".
  const t2 = await createTenant(pool);
  await upsertLineReportConfig(pool, t2.id, { enabled: true, taxonomy: ['Claims'] });
  const s2 = capStub({ subject: 's', body: 'b' });
  await composeDigest({ pool, tenantId: t2.id, llm: s2.llm as any, model: 'gpt-4o', periodLabel: 'daily', start, end });
  expect(s2.seen.join(' ')).toContain('the client');
  expect(s2.seen.join(' ')).not.toContain('ABSA');
});
