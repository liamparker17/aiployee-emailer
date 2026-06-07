import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createAgent, listAgents, getAgentForLaunch, updateAgent } from '../src/repos/callAgents.js';

const KEY = Buffer.alloc(32, 7);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('callAgents repo', () => {
  it('encrypts company_key on create and never returns it from listAgents', async () => {
    const t = await createTenant(pool);
    const agent = await createAgent(pool, KEY, {
      tenantId: t.id, label: 'Arrears', companyKey: 'V7E-secret-key',
      valuesSchema: [{ key: 'unit_number', label: 'Unit', required: true }],
    });
    expect(agent).not.toHaveProperty('company_key_encrypted');
    expect(agent).not.toHaveProperty('companyKey');

    const list = await listAgents(pool, t.id);
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('Arrears');
    expect(list[0]).not.toHaveProperty('companyKey');
    expect(JSON.stringify(list[0])).not.toContain('V7E-secret-key');
  });

  it('getAgentForLaunch decrypts the key (server-only)', async () => {
    const t = await createTenant(pool);
    const agent = await createAgent(pool, KEY, { tenantId: t.id, label: 'A', companyKey: 'sk-123', valuesSchema: [] });
    const launch = await getAgentForLaunch(pool, KEY, t.id, agent.id);
    expect(launch?.companyKey).toBe('sk-123');
    expect(launch?.defaultTimezone).toBe('Africa/Johannesburg');
  });

  it('updateAgent can rotate the key and toggle active', async () => {
    const t = await createTenant(pool);
    const agent = await createAgent(pool, KEY, { tenantId: t.id, label: 'A', companyKey: 'old', valuesSchema: [] });
    await updateAgent(pool, KEY, t.id, agent.id, { companyKey: 'new', active: false });
    const launch = await getAgentForLaunch(pool, KEY, t.id, agent.id);
    expect(launch?.companyKey).toBe('new');
    expect(launch?.active).toBe(false);
  });

  it('cross-tenant getAgentForLaunch returns null', async () => {
    const t1 = await createTenant(pool); const t2 = await createTenant(pool);
    const agent = await createAgent(pool, KEY, { tenantId: t1.id, label: 'A', companyKey: 'k', valuesSchema: [] });
    expect(await getAgentForLaunch(pool, KEY, t2.id, agent.id)).toBeNull();
  });
});
