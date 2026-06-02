import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { seedInboundCall } from './helpers/lineReport.js';
import { upsertLineReportConfig } from '../src/repos/lineReportConfigs.js';
import { listReports } from '../src/repos/lineReports.js';
import { runLineReportShift } from '../src/agent/abe/lineShift.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

it('disabled config => skipped, no reports', async () => {
  const t = await createTenant(pool);
  await upsertLineReportConfig(pool, t.id, { enabled: false });
  const stub = () => ({ chat: async () => ({ content: '{"tags":[]}' }) });
  const r = await runLineReportShift({ pool, tenantId: t.id, llmFactory: stub as any, model: 'gpt-4o', now: new Date('2026-06-02T06:00:00Z') });
  expect(r.status).toBe('skipped');
  expect(await listReports(pool, t.id)).toHaveLength(0);
});

it('tags calls and drafts a daily digest + case, all pending_approval', async () => {
  const t = await createTenant(pool);
  const now = new Date(); // align with DB-stamped seed row
  // digests are gated to the configured UTC hour — set it to "now" so the daily digest fires
  await upsertLineReportConfig(pool, t.id, { enabled: true, dailyDigest: true, sendHourUtc: now.getUTCHours() });
  await seedInboundCall(pool, t.id, 'card fraud reported');
  let call = 0;
  const stub = () => ({ chat: async () => {
    call++;
    return { content: call === 1
      ? JSON.stringify({ tags: [{ ref: 1, category: 'Card disputes / fraud', severity: 'high', is_emerging: false }] })
      : JSON.stringify({ subject: 'Daily', body: 'A card-fraud call today.', advisory: { diagnosis: 'd', root_cause_hypothesis: null, recommended_actions: [{ action: 'a', owner: 'o', urgency: 'high' }], draft_comms: { customer_message: '', internal_note: '', talking_points: [] } } }) };
  } });
  const r = await runLineReportShift({ pool, tenantId: t.id, llmFactory: stub as any, model: 'gpt-4o', now });
  expect(r.status).toBe('ran');
  const reports = await listReports(pool, t.id);
  expect(reports.length).toBeGreaterThan(0);
  expect(reports.every(x => x.status === 'pending_approval')).toBe(true);
  expect(reports.some(x => x.report_type === 'digest')).toBe(true);
  expect(reports.some(x => x.report_type === 'case')).toBe(true);
});
