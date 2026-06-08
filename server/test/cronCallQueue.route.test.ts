import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '@aiployee/core';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createAgent } from '../src/repos/callAgents.js';
import { createCampaign, addRecipientsFromCsv, approveCampaign } from '../src/repos/callCampaigns.js';

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
afterEach(() => { vi.unstubAllGlobals(); });

describe('POST /v1/cron/process-call-queue', () => {
  it('401 without the cron secret', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/cron/process-call-queue' });
    expect(res.statusCode).toBe(401);
  });

  it('claims and reports a summary with the cron secret', async () => {
    const t = await createTenant(pool);
    const a = await createAgent(pool, Buffer.alloc(32, 1), { tenantId: t.id, label: 'A', companyKey: 'k', valuesSchema: [] });
    const c = await createCampaign(pool, { tenantId: t.id, agentId: a.id, name: 'C', audienceType: 'csv' });
    await addRecipientsFromCsv(pool, { tenantId: t.id, campaignId: c.id, agentId: a.id, rows: [{ name: 'n', phone: '+2760' }] });
    await approveCampaign(pool, t.id, c.id, null);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'accepted' }), { status: 200 })));
    const res = await app.inject({ method: 'POST', url: '/v1/cron/process-call-queue', headers: { authorization: 'Bearer ' + 'c'.repeat(24) } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(JSON.parse(res.body).claimed).toBe(1);
  });
});
