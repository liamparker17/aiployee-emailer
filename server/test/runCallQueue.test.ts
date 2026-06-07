import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createAgent } from '../src/repos/callAgents.js';
import { createCampaign, addRecipientsFromCsv, approveCampaign, getCampaign, listRecipients } from '../src/repos/callCampaigns.js';
import { runCallQueue } from '../src/calls/runCallQueue.js';

const KEY = Buffer.alloc(32, 7);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function approved(n: number) {
  const t = await createTenant(pool);
  const a = await createAgent(pool, KEY, { tenantId: t.id, label: 'A', companyKey: 'company-key-xyz', valuesSchema: [] });
  const c = await createCampaign(pool, { tenantId: t.id, agentId: a.id, name: 'C', audienceType: 'csv' });
  await addRecipientsFromCsv(pool, { tenantId: t.id, campaignId: c.id, agentId: a.id,
    rows: Array.from({ length: n }, (_, i) => ({ name: `n${i}`, phone: `+2760000000${i}` })) });
  await approveCampaign(pool, t.id, c.id, null);
  return { t, a, c };
}

describe('runCallQueue', () => {
  it('launches pending recipients via the injected LaunchFn and decrypts the right company_key', async () => {
    const { t, c } = await approved(2);
    const launch = vi.fn(async () => ({ ok: true, status: 200, body: { status: 'accepted' } }));
    const summary = await runCallQueue(pool, KEY, { batchSize: 10, maxAttempts: 3 }, launch);
    expect(summary.launched).toBe(2);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls[0][0].companyKey).toBe('company-key-xyz');
    const recips = await listRecipients(pool, t.id, c.id, {});
    expect(recips.recipients.every(r => r.status === 'launched')).toBe(true);
    expect((await getCampaign(pool, t.id, c.id))?.status).toBe('running');
  });

  it('marks a recipient failed on a non-2xx and retries it next run, then gives up at maxAttempts', async () => {
    const { t, c } = await approved(1);
    const launch = vi.fn(async () => ({ ok: false, status: 500, body: null }));
    await runCallQueue(pool, KEY, { batchSize: 10, maxAttempts: 2 }, launch);
    await runCallQueue(pool, KEY, { batchSize: 10, maxAttempts: 2 }, launch);
    const recips = await listRecipients(pool, t.id, c.id, {});
    expect(recips.recipients[0].status).toBe('failed');
    expect(recips.recipients[0].attempts).toBe(2);
    await runCallQueue(pool, KEY, { batchSize: 10, maxAttempts: 2 }, launch);
    expect((await getCampaign(pool, t.id, c.id))?.status).toBe('completed');
  });

  it('suppresses a recipient when checkSuppressed returns true (no launch)', async () => {
    const { t, c } = await approved(1);
    const launch = vi.fn(async () => ({ ok: true, status: 200, body: {} }));
    const summary = await runCallQueue(pool, KEY, { batchSize: 10, maxAttempts: 3 }, launch, async () => true);
    expect(launch).not.toHaveBeenCalled();
    expect(summary.suppressed).toBe(1);
    const recips = await listRecipients(pool, t.id, c.id, {});
    expect(recips.recipients[0].status).toBe('suppressed');
  });
});
