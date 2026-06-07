import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createAgent } from '../src/repos/callAgents.js';
import { createCampaign, addRecipientsFromCsv, approveCampaign, getCampaign } from '../src/repos/callCampaigns.js';
import { claimPending, markLaunched, markFailed, completeFinishedCampaigns, linkResultBySuid } from '../src/repos/callCampaigns.js';

const KEY = Buffer.alloc(32, 7);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function approvedCampaign(n: number) {
  const t = await createTenant(pool);
  const a = await createAgent(pool, KEY, { tenantId: t.id, label: 'A', companyKey: 'k', valuesSchema: [] });
  const c = await createCampaign(pool, { tenantId: t.id, agentId: a.id, name: 'C', audienceType: 'csv' });
  const rows = Array.from({ length: n }, (_, i) => ({ name: `n${i}`, phone: `+2760000000${i}` }));
  await addRecipientsFromCsv(pool, { tenantId: t.id, campaignId: c.id, agentId: a.id, rows });
  await approveCampaign(pool, t.id, c.id, null);
  return { t, c };
}

describe('callCampaigns repo — worker helpers', () => {
  it('claimPending claims approved-campaign recipients and flips them to queued', async () => {
    const { c } = await approvedCampaign(3);
    const claimed = await claimPending(pool, 2, 3);
    expect(claimed).toHaveLength(2);
    expect(claimed.every(r => r.status === 'queued')).toBe(true);
    expect(claimed[0].campaign_id).toBe(c.id);
  });

  it('markLaunched sets launched + attempts; campaign flips to running', async () => {
    const { t, c } = await approvedCampaign(1);
    const [r] = await claimPending(pool, 10, 3);
    await markLaunched(pool, r.id, { status: 'accepted' });
    const recips = await pool.query(`SELECT status, attempts, launched_at FROM call_campaign_recipients WHERE id = $1`, [r.id]);
    expect(recips.rows[0].status).toBe('launched');
    expect(recips.rows[0].attempts).toBe(1);
    expect(recips.rows[0].launched_at).not.toBeNull();
    expect((await getCampaign(pool, t.id, c.id))?.status).toBe('running');
  });

  it('markFailed increments attempts and records the error', async () => {
    await approvedCampaign(1);
    const [r] = await claimPending(pool, 10, 3);
    await markFailed(pool, r.id, 'boom');
    const recips = await pool.query(`SELECT status, attempts, last_error FROM call_campaign_recipients WHERE id = $1`, [r.id]);
    expect(recips.rows[0].status).toBe('failed');
    expect(recips.rows[0].attempts).toBe(1);
    expect(recips.rows[0].last_error).toBe('boom');
  });

  it('completeFinishedCampaigns marks a campaign completed when nothing is left to do', async () => {
    const { t, c } = await approvedCampaign(1);
    const [r] = await claimPending(pool, 10, 3);
    await markLaunched(pool, r.id, {});
    await pool.query(`UPDATE call_campaign_recipients SET status = 'completed' WHERE id = $1`, [r.id]);
    await completeFinishedCampaigns(pool, 3);
    expect((await getCampaign(pool, t.id, c.id))?.status).toBe('completed');
  });

  it('linkResultBySuid returns false when no recipient matches', async () => {
    const t = await createTenant(pool);
    expect(await linkResultBySuid(pool, t.id, 'no-such-suid', null, 'completed')).toBe(false);
  });
});
