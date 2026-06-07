import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant, createUser } from './helpers/factories.js';
import { csrfFor, login } from './helpers/auth.js';
import { createAgent } from '../src/repos/callAgents.js';

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

async function adminSession() {
  const t = await createTenant(pool);
  const password = 'pw-12345678';
  await createUser(pool, { tenantId: t.id, email: 'admin@x.io', password, role: 'tenant_admin' });
  const csrf = await csrfFor(app);
  const headers = await login(app, { email: 'admin@x.io', password }, csrf);
  return { tenantId: t.id, headers };
}
async function nonAdminSession(tenantId: string) {
  const password = 'pw-99999999';
  await createUser(pool, { tenantId, email: 'user@x.io', password, role: 'tenant_user' });
  const csrf = await csrfFor(app);
  const headers = await login(app, { email: 'user@x.io', password }, csrf);
  return { headers };
}

describe('call campaigns routes', () => {
  it('create -> add CSV recipients -> approve happy path', async () => {
    const { tenantId, headers } = await adminSession();
    const a = await createAgent(pool, KEY, { tenantId, label: 'A', companyKey: 'k',
      valuesSchema: [{ key: 'unit_number', label: 'Unit', required: true }] });
    const create = await app.inject({ method: 'POST', url: '/api/calls/campaigns', headers,
      payload: { agent_id: a.id, name: 'Q3', audience_type: 'csv' } });
    expect(create.statusCode).toBe(201);
    const campaignId = JSON.parse(create.body).campaign.id;

    const recips = await app.inject({ method: 'POST', url: `/api/calls/campaigns/${campaignId}/recipients`, headers,
      payload: { source: 'csv', rows: [{ name: 'Renier', phone: '+27609381283', unit_number: '103' }] } });
    expect(JSON.parse(recips.body).added).toBe(1);

    const approve = await app.inject({ method: 'POST', url: `/api/calls/campaigns/${campaignId}/approve`, headers });
    expect(approve.statusCode).toBe(200);
    expect(JSON.parse(approve.body).campaign.status).toBe('approved');
  });

  it('approve fails (400) when a required value is missing', async () => {
    const { tenantId, headers } = await adminSession();
    const a = await createAgent(pool, KEY, { tenantId, label: 'A', companyKey: 'k',
      valuesSchema: [{ key: 'unit_number', label: 'Unit', required: true }] });
    const create = await app.inject({ method: 'POST', url: '/api/calls/campaigns', headers,
      payload: { agent_id: a.id, name: 'Bad', audience_type: 'csv' } });
    const campaignId = JSON.parse(create.body).campaign.id;
    await app.inject({ method: 'POST', url: `/api/calls/campaigns/${campaignId}/recipients`, headers,
      payload: { source: 'csv', rows: [{ name: 'NoUnit', phone: '+2760' }] } });
    const approve = await app.inject({ method: 'POST', url: `/api/calls/campaigns/${campaignId}/approve`, headers });
    expect(approve.statusCode).toBe(400);
  });

  it('403 for a non-admin', async () => {
    const { tenantId } = await adminSession();
    const { headers } = await nonAdminSession(tenantId);
    const res = await app.inject({ method: 'GET', url: '/api/calls/campaigns', headers });
    expect(res.statusCode).toBe(403);
  });
});
