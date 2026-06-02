import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { seedInboundCall } from './helpers/lineReport.js';
import { upsertLineReportConfig } from '../src/repos/lineReportConfigs.js';
import { insertCallTag } from '../src/repos/lineCallTags.js';
import { listReports } from '../src/repos/lineReports.js';
import { composeDigest, composeCase } from '../src/agent/abe/lineCompose.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

const stubLlm = { chat: async () => ({ content: JSON.stringify({
  subject: 'ABSA line — daily', body: 'One card-fraud call today.',
  advisory: {
    diagnosis: 'Single card-fraud report today.',
    root_cause_hypothesis: 'Isolated; no pattern yet (hypothesis).',
    recommended_actions: [{ action: 'Confirm card blocked', owner: 'Fraud team', urgency: 'high' }],
    draft_comms: { customer_message: 'We have secured your card…', internal_note: 'One fraud case logged.', talking_points: ['Card secured', 'Monitoring'] },
  },
}) }) };

it('composes a pending_approval digest with category metrics + advisory', async () => {
  const t = await createTenant(pool);
  await upsertLineReportConfig(pool, t.id, { enabled: true });
  const m = await seedInboundCall(pool, t.id, 'card fraud');
  await insertCallTag(pool, { tenantId: t.id, messageId: m.id, category: 'Card disputes / fraud', severity: 'high', isEmerging: false });

  const start = new Date(0), end = new Date(Date.now() + 1000);
  const report = await composeDigest({ pool, tenantId: t.id, llm: stubLlm as any, model: 'gpt-4o', periodLabel: 'daily', start, end });

  expect(report.status).toBe('pending_approval');
  expect(report.report_type).toBe('digest');
  expect((report.metrics as any).total).toBe(1);
  expect((report.metrics as any).byCategory['Card disputes / fraud']).toBe(1);
  expect(report.advisory.recommended_actions[0]).toMatchObject({ owner: 'Fraud team', urgency: 'high' });
  expect(report.advisory.draft_comms.talking_points).toContain('Card secured');
  // advisory woven into the emailed body so the approved email is self-contained:
  expect(report.body).toContain('Recommended actions');
  expect(report.body).toContain('Confirm card blocked');
  const all = await listReports(pool, t.id);
  expect(all).toHaveLength(1);
});

it('composeCase escalates one call with advisory + source id', async () => {
  const t = await createTenant(pool);
  await upsertLineReportConfig(pool, t.id, { enabled: true });
  const m = await seedInboundCall(pool, t.id, 'vulnerable customer, urgent');
  const report = await composeCase({ pool, tenantId: t.id, llm: stubLlm as any, model: 'gpt-4o', messageId: m.id, content: 'vulnerable customer, urgent' });
  expect(report.report_type).toBe('case');
  expect(report.status).toBe('pending_approval');
  expect(report.source_message_ids).toContain(m.id);
  expect(report.advisory.recommended_actions.length).toBeGreaterThan(0);
});
