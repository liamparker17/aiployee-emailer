import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '@aiployee/core';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { upsertLineReportConfig } from '../src/repos/lineReportConfigs.js';
import { seedInboundCall } from './helpers/lineReport.js';

const encKeyB64 = Buffer.alloc(32, 1).toString('base64');
const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: encKeyB64,
  PUBLIC_BASE_URL: 'http://localhost:3000',
  CRON_SECRET: 'c'.repeat(24),
});

// Returns valid JSON for both the tagger call (call 1) and digest/case calls (subsequent calls).
let stubCallCount = 0;
const stubFactory = () => ({
  chat: async () => {
    stubCallCount++;
    if (stubCallCount === 1) {
      // First call: tagger response
      return { content: JSON.stringify({ tags: [] }) };
    }
    // Subsequent calls: digest/case compose response
    return {
      content: JSON.stringify({
        subject: 'Daily digest',
        body: 'Summary.',
        advisory: {
          diagnosis: 'd',
          root_cause_hypothesis: null,
          recommended_actions: [{ action: 'a', owner: 'o', urgency: 'high' }],
          draft_comms: { customer_message: '', internal_note: '', talking_points: [] },
        },
      }),
    };
  },
});

let app: Awaited<ReturnType<typeof buildApp>>;
const pool = makePool();

beforeAll(async () => { app = await buildApp({ cfg, agentLlmFactory: stubFactory }); });
beforeEach(async () => { await truncateAll(pool); stubCallCount = 0; });
afterAll(async () => { await app.close(); await pool.end(); });

describe('POST /v1/cron/line-report', () => {
  it('rejects without the cron secret', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/cron/line-report' });
    expect(res.statusCode).toBe(401);
  });

  it('returns ok with 0 configs when no enabled configs exist', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/cron/line-report',
      headers: { 'x-cron-secret': 'c'.repeat(24) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.configs).toBe(0);
    expect(body.ran).toBe(0);
  });

  it('runs the shift for enabled configs', async () => {
    const t = await createTenant(pool);
    await upsertLineReportConfig(pool, t.id, { enabled: true, dailyDigest: true });
    await seedInboundCall(pool, t.id, 'debit order dispute');

    const res = await app.inject({
      method: 'POST', url: '/v1/cron/line-report',
      headers: { 'x-cron-secret': 'c'.repeat(24) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.configs).toBe(1);
    expect(body.ran).toBe(1);
  });

  it('skips disabled configs', async () => {
    const t = await createTenant(pool);
    await upsertLineReportConfig(pool, t.id, { enabled: false });

    const res = await app.inject({
      method: 'POST', url: '/v1/cron/line-report',
      headers: { 'x-cron-secret': 'c'.repeat(24) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.configs).toBe(0); // listEnabledLineConfigs filters to enabled=true only
    expect(body.ran).toBe(0);
  });
});
