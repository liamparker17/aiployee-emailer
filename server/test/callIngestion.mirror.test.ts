import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { upsertLineReportConfig } from '../src/repos/lineReportConfigs.js';
import { listCalls } from '../src/repos/callAnalytics.js';
import { mirrorEmailAsCall, captureCallFromSend } from '../src/agent/abe/mirrorCall.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

const EMAIL_ID = '11111111-1111-1111-1111-111111111111';

it('mirrors a summary into an inbound call, idempotently', async () => {
  const t = await createTenant(pool);
  expect(await mirrorEmailAsCall({ pool, tenantId: t.id, emailId: EMAIL_ID, summary: 'caller about a claim' })).toBe(true);
  expect(await mirrorEmailAsCall({ pool, tenantId: t.id, emailId: EMAIL_ID, summary: 'caller about a claim' })).toBe(false); // dup
  const { calls, total } = await listCalls(pool, t.id, {});
  expect(total).toBe(1);
  expect(calls[0].content).toContain('claim');
});

it('captureCallFromSend only mirrors when the tenant opted in', async () => {
  const t = await createTenant(pool);
  expect(await captureCallFromSend({ pool, tenantId: t.id, emailId: EMAIL_ID, summaryVar: 'policy query' })).toBe(false);
  expect((await listCalls(pool, t.id, {})).total).toBe(0);
  await upsertLineReportConfig(pool, t.id, { enabled: true, ingestSendsAsCalls: true });
  expect(await captureCallFromSend({ pool, tenantId: t.id, emailId: EMAIL_ID, summaryVar: 'policy query' })).toBe(true);
  const id2 = '22222222-2222-2222-2222-222222222222';
  expect(await captureCallFromSend({ pool, tenantId: t.id, emailId: id2, html: '<p>claim for <b>hail</b></p>' })).toBe(true);
  const { calls } = await listCalls(pool, t.id, {});
  expect(calls.map(c => c.content).sort()).toEqual(['claim for hail', 'policy query']);
});
