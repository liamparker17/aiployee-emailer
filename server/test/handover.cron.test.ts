import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '@aiployee/core';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { upsertLineReportConfig } from '../src/repos/lineReportConfigs.js';
import { seedInboundCall } from './helpers/lineReport.js';
import { listHandovers } from '../src/repos/callHandovers.js';

const encKeyB64 = Buffer.alloc(32, 1).toString('base64');
const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: encKeyB64,
  PUBLIC_BASE_URL: 'http://localhost:3000',
  CRON_SECRET: 'c'.repeat(24),
});

// Stub factory: returns handover-extraction JSON that extractHandovers can parse.
const stubFactory = () => ({
  chat: async () => ({
    content: JSON.stringify({
      items: [{
        ref: 1,
        caller_name: 'A',
        caller_phone: '0820000000',
        account_ref: null,
        reason_category: 'Card disputes / fraud',
        summary: 's',
        recommended_action: 'call',
        urgency: 'high',
        vulnerable: false,
        needs_followup: true,
      }],
    }),
  }),
});

let app: Awaited<ReturnType<typeof buildApp>>;
const pool = makePool();

beforeAll(async () => { app = await buildApp({ cfg, agentLlmFactory: stubFactory }); });
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await pool.end(); });

describe('POST /v1/cron/abe-handovers', () => {
  it('rejects without the cron secret', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/cron/abe-handovers' });
    expect(res.statusCode).toBe(401);
  });

  it('returns ok with 0 configs when no enabled configs exist', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/cron/abe-handovers',
      headers: { 'x-cron-secret': 'c'.repeat(24) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.configs).toBe(0);
    expect(body.ran).toBe(0);
  });

  it('extracts handovers for enabled configs', async () => {
    const t = await createTenant(pool);
    await upsertLineReportConfig(pool, t.id, { enabled: true });
    await seedInboundCall(pool, t.id, 'caller wants a callback about a card dispute');

    const res = await app.inject({
      method: 'POST', url: '/v1/cron/abe-handovers',
      headers: { 'x-cron-secret': 'c'.repeat(24) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.configs).toBe(1);

    const list = await listHandovers(pool, t.id);
    expect(list.length).toBeGreaterThan(0);
  });
});
