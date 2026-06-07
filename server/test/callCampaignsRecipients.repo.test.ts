import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createAgent } from '../src/repos/callAgents.js';
import { createCampaign, getCampaign, validateRecipients,
  addRecipientsFromCsv, addRecipientsFromAudience, listRecipients } from '../src/repos/callCampaigns.js';

const KEY = Buffer.alloc(32, 7);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

const schema = [{ key: 'unit_number', label: 'Unit', required: true }, { key: 'arrears_amount', label: 'Arrears', required: false }];

async function setup() {
  const t = await createTenant(pool);
  const a = await createAgent(pool, KEY, { tenantId: t.id, label: 'Arrears', companyKey: 'k', valuesSchema: schema });
  const c = await createCampaign(pool, { tenantId: t.id, agentId: a.id, name: 'C', audienceType: 'csv' });
  return { t, a, c };
}

describe('callCampaigns repo — recipients', () => {
  it('addRecipientsFromCsv maps name/phone/values and bumps recipient_count', async () => {
    const { t, c } = await setup();
    const res = await addRecipientsFromCsv(pool, { tenantId: t.id, campaignId: c.id, agentId: c.agent_id,
      rows: [{ name: 'Renier', phone: '+27609381283', unit_number: '103', arrears_amount: '2449.46' }] });
    expect(res.added).toBe(1);
    expect(res.errors).toHaveLength(0);
    const recips = await listRecipients(pool, t.id, c.id, {});
    expect(recips.recipients[0].name).toBe('Renier');
    expect(recips.recipients[0].values).toEqual({ unit_number: '103', arrears_amount: '2449.46' });
    expect((await getCampaign(pool, t.id, c.id))?.recipient_count).toBe(1);
  });

  it('addRecipientsFromCsv flags a row missing a required value', async () => {
    const { t, c } = await setup();
    const res = await addRecipientsFromCsv(pool, { tenantId: t.id, campaignId: c.id, agentId: c.agent_id,
      rows: [{ name: 'NoUnit', phone: '+2760', arrears_amount: '10' }] });
    expect(res.added).toBe(0);
    expect(res.errors.length).toBeGreaterThan(0);
  });

  it('addRecipientsFromAudience pulls phone + values from contact attributes', async () => {
    const { t, a } = await setup();
    const contact = await pool.query(
      `INSERT INTO contacts (tenant_id, email, name, attributes) VALUES ($1,$2,$3,$4) RETURNING id`,
      [t.id, 'r@x.io', 'Renier', JSON.stringify({ phone: '+27609381283', unit_number: '103' })]);
    const list = await pool.query(`INSERT INTO contact_lists (tenant_id, name) VALUES ($1,'L') RETURNING id`, [t.id]);
    await pool.query(`INSERT INTO contact_list_members (list_id, contact_id) VALUES ($1,$2)`, [list.rows[0].id, contact.rows[0].id]);
    const c2 = await createCampaign(pool, { tenantId: t.id, agentId: a.id, name: 'L', audienceType: 'list', audienceId: list.rows[0].id });
    const res = await addRecipientsFromAudience(pool, { tenantId: t.id, campaignId: c2.id, agentId: a.id, audienceType: 'list', audienceId: list.rows[0].id });
    expect(res.added).toBe(1);
    const recips = await listRecipients(pool, t.id, c2.id, {});
    expect(recips.recipients[0].phone).toBe('+27609381283');
    expect(recips.recipients[0].values).toEqual({ unit_number: '103' });
    expect(recips.recipients[0].contact_id).toBe(contact.rows[0].id);
  });

  it('validateRecipients returns ok=false when a required value is missing', async () => {
    const { t, c } = await setup();
    await pool.query(
      `INSERT INTO call_campaign_recipients (tenant_id, campaign_id, suid, name, phone, values)
       VALUES ($1,$2,$3,'X','+2760','{}')`, [t.id, c.id, 'suid-1']);
    const v = await validateRecipients(pool, t.id, c.id);
    expect(v.ok).toBe(false);
  });
});
