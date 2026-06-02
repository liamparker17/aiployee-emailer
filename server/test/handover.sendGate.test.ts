import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { seedInboundCall } from './helpers/lineReport.js';
import { upsertLineReportConfig } from '../src/repos/lineReportConfigs.js';
import { extractHandovers } from '../src/agent/abe/handoverExtract.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

it('extraction creates ZERO emails — only forward sends', async () => {
  const t = await createTenant(pool);
  await upsertLineReportConfig(pool, t.id, { enabled: true, recipients: ['callbacks@absa.co.za'] });
  await seedInboundCall(pool, t.id, 'urgent fraud callback needed');
  const stub = { chat: async () => ({ content: JSON.stringify({ items: [{ ref: 1, caller_name: 'A', caller_phone: '0820000000', account_ref: null, reason_category: 'Card disputes / fraud', summary: 's', recommended_action: 'call', urgency: 'high', vulnerable: false, needs_followup: true }] }) }) };
  await extractHandovers({ pool, tenantId: t.id, llm: stub as any, model: 'gpt-4o', batch: 50 });
  const sent = await pool.query(`SELECT count(*)::int AS n FROM emails WHERE tenant_id=$1`, [t.id]);
  expect(sent.rows[0].n).toBe(0);
});
