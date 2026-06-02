import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { seedInboundCall } from './helpers/lineReport.js';
import { upsertLineReportConfig } from '../src/repos/lineReportConfigs.js';
import { listHandovers } from '../src/repos/callHandovers.js';
import { extractHandovers } from '../src/agent/abe/handoverExtract.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

it('extracts a handover, flags a missing phone, and is idempotent', async () => {
  const t = await createTenant(pool);
  await upsertLineReportConfig(pool, t.id, { enabled: true });
  await seedInboundCall(pool, t.id, 'Elderly caller Thandi, account 4471, two debit orders went off, wants reversal. No number left.');
  const stub = { chat: async () => ({ content: JSON.stringify({
    caller_name: 'Thandi', caller_phone: null, account_ref: '4471',
    reason_category: 'Debit orders', summary: 'Duplicate debit; wants reversal.',
    recommended_action: 'Reverse duplicate; call back today.', urgency: 'high',
    vulnerable: true, needs_followup: true,
  }) }) };
  const n = await extractHandovers({ pool, tenantId: t.id, llm: stub as any, model: 'gpt-4o', batch: 50 });
  expect(n).toBe(1);
  const pending = await listHandovers(pool, t.id, 'pending');
  expect(pending[0]).toMatchObject({ caller_name: 'Thandi', account_ref: '4471', urgency: 'high', vulnerable: true });
  expect(pending[0].caller_phone).toBeNull();
  expect(pending[0].missing_fields).toContain('caller_phone');
  expect(await extractHandovers({ pool, tenantId: t.id, llm: stub as any, model: 'gpt-4o', batch: 50 })).toBe(0);
});

it('needs_followup=false is stored as dismissed (not pending)', async () => {
  const t = await createTenant(pool);
  await upsertLineReportConfig(pool, t.id, { enabled: true });
  await seedInboundCall(pool, t.id, 'Caller just wanted branch hours; resolved on call.');
  const stub = { chat: async () => ({ content: JSON.stringify({
    caller_name: 'A', caller_phone: '0820000000', account_ref: null, reason_category: 'Other / Emerging',
    summary: 'Branch hours given.', recommended_action: '', urgency: 'low', vulnerable: false, needs_followup: false,
  }) }) };
  await extractHandovers({ pool, tenantId: t.id, llm: stub as any, model: 'gpt-4o', batch: 50 });
  expect(await listHandovers(pool, t.id, 'pending')).toHaveLength(0);
  expect(await listHandovers(pool, t.id, 'dismissed')).toHaveLength(1);
});
