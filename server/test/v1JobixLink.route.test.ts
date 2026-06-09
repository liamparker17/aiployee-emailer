import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '@aiployee/core';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { insertApiKey } from '@aiployee/core';
import { generateApiKey, hashApiKey, prefixOf } from '@aiployee/core';
import { createAgent } from '../src/repos/callAgents.js';
import { createCampaign, addRecipientsFromCsv, approveCampaign, listRecipients } from '../src/repos/callCampaigns.js';

const KEY = Buffer.alloc(32, 1);
const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32), EMAILER_ENC_KEY: KEY.toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000', CRON_SECRET: 'c'.repeat(24),
});

let app: Awaited<ReturnType<typeof buildApp>>;
const pool = makePool();
beforeAll(async () => { app = await buildApp({ cfg }); });
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await pool.end(); });

async function withKey() {
  const t = await createTenant(pool);
  const key = generateApiKey();
  await insertApiKey(pool, { tenantId: t.id, name: 'k', keyHash: hashApiKey(key), keyPrefix: prefixOf(key) });
  return { t, key };
}

describe('v1/jobix/calls links outbound recipients by suid', () => {
  it('a result with a known suid completes the recipient and links the message', async () => {
    const { t, key } = await withKey();
    const a = await createAgent(pool, KEY, { tenantId: t.id, label: 'A', companyKey: 'k', valuesSchema: [] });
    const c = await createCampaign(pool, { tenantId: t.id, agentId: a.id, name: 'C', audienceType: 'csv' });
    await addRecipientsFromCsv(pool, { tenantId: t.id, campaignId: c.id, agentId: a.id, rows: [{ name: 'Renier', phone: '+2760' }] });
    await approveCampaign(pool, t.id, c.id, null);
    const before = await listRecipients(pool, t.id, c.id, {});
    const suid = before.recipients[0].suid;

    const res = await app.inject({
      method: 'POST', url: '/v1/jobix/calls',
      headers: { authorization: `Bearer ${key}` },
      payload: {
        customer_data: { main: { suid } },
        call_outcome: 'completed',
        call_summary: 'done',
        timestamp: '2026-06-07T10:00:00Z',
      },
    });
    expect(res.statusCode).toBe(202);

    const after = await listRecipients(pool, t.id, c.id, {});
    expect(after.recipients[0].status).toBe('completed');
    expect(after.recipients[0].outcome).toBe('completed');
    expect(after.recipients[0].result_message_id).toBeTruthy();
  });

  it('a result with an unknown suid still ingests (no error, recipient untouched)', async () => {
    const { key } = await withKey();
    const res = await app.inject({
      method: 'POST', url: '/v1/jobix/calls',
      headers: { authorization: `Bearer ${key}` },
      payload: {
        customer_data: { main: { suid: 'totally-unknown' } },
        call_summary: 'x',
        timestamp: '2026-06-07T10:00:00Z',
      },
    });
    expect(res.statusCode).toBe(202);
  });
});
