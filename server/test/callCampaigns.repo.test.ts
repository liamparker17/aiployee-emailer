import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createAgent } from '../src/repos/callAgents.js';
import { createCampaign, getCampaign, listCampaigns, approveCampaign, cancelCampaign } from '../src/repos/callCampaigns.js';

const KEY = Buffer.alloc(32, 7);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function agentFor(tenantId: string) {
  return createAgent(pool, KEY, { tenantId, label: 'A', companyKey: 'k', valuesSchema: [] });
}

describe('callCampaigns repo — campaigns', () => {
  it('creates a draft campaign', async () => {
    const t = await createTenant(pool); const a = await agentFor(t.id);
    const c = await createCampaign(pool, { tenantId: t.id, agentId: a.id, name: 'Q3 arrears', audienceType: 'csv' });
    expect(c.status).toBe('draft');
    const got = await getCampaign(pool, t.id, c.id);
    expect(got?.name).toBe('Q3 arrears');
    expect(got?.counts).toEqual({ pending: 0, queued: 0, launched: 0, failed: 0, suppressed: 0, completed: 0, canceled: 0 });
  });

  it('approveCampaign rejects a campaign with zero recipients', async () => {
    const t = await createTenant(pool); const a = await agentFor(t.id);
    const c = await createCampaign(pool, { tenantId: t.id, agentId: a.id, name: 'Empty', audienceType: 'csv' });
    await expect(approveCampaign(pool, t.id, c.id, null)).rejects.toThrow();
    const got = await getCampaign(pool, t.id, c.id);
    expect(got?.status).toBe('draft');
  });

  it('cancelCampaign moves draft to canceled', async () => {
    const t = await createTenant(pool); const a = await agentFor(t.id);
    const c = await createCampaign(pool, { tenantId: t.id, agentId: a.id, name: 'X', audienceType: 'csv' });
    await cancelCampaign(pool, t.id, c.id);
    expect((await getCampaign(pool, t.id, c.id))?.status).toBe('canceled');
  });

  it('listCampaigns is tenant-scoped', async () => {
    const t1 = await createTenant(pool); const t2 = await createTenant(pool);
    const a = await agentFor(t1.id);
    await createCampaign(pool, { tenantId: t1.id, agentId: a.id, name: 'mine', audienceType: 'csv' });
    expect(await listCampaigns(pool, t2.id)).toHaveLength(0);
    expect(await listCampaigns(pool, t1.id)).toHaveLength(1);
  });
});
