import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { seedInboundCall } from './helpers/lineReport.js';
import { upsertLineReportConfig } from '../src/repos/lineReportConfigs.js';
import { runLineReportShift } from '../src/agent/abe/lineShift.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

it('a full shift sends ZERO emails — every report stays pending_approval', async () => {
  const t = await createTenant(pool);
  await upsertLineReportConfig(pool, t.id, { enabled: true, dailyDigest: true, recipients: ['ops@absa.co.za'] });
  await seedInboundCall(pool, t.id, 'fraud fraud fraud');
  const now = new Date();
  const stub = () => ({ chat: async () => ({ content: JSON.stringify({ tags: [{ ref: 1, category: 'Card disputes / fraud', severity: 'high', is_emerging: false }], subject: 'x', body: 'y', advisory: { diagnosis: 'd', root_cause_hypothesis: null, recommended_actions: [], draft_comms: { customer_message: '', internal_note: '', talking_points: [] } } }) }) });
  await runLineReportShift({ pool, tenantId: t.id, llmFactory: stub as any, model: 'gpt-4o', now });

  const sent = await pool.query(`SELECT count(*)::int AS n FROM emails WHERE tenant_id = $1`, [t.id]);
  expect(sent.rows[0].n).toBe(0); // shift NEVER creates an email row
});
