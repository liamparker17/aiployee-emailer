import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { upsertGoal } from '../src/repos/agentGoals.js';
import { listPlays } from '../src/repos/agentPlays.js';
import { encrypt } from '../src/crypto/enc.js';

const encKeyB64 = Buffer.alloc(32, 1).toString('base64');
const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: encKeyB64,
  PUBLIC_BASE_URL: 'http://localhost:3000',
  CRON_SECRET: 'c'.repeat(24),
});

const stubFactory = () => ({
  chat: async () => ({ content: JSON.stringify({ touches: [{ subject: 'Miss you', body_html: '<p>hi</p>' }] }), toolCalls: [] }),
});

let app: Awaited<ReturnType<typeof buildApp>>;
const pool = makePool();

beforeAll(async () => { app = await buildApp({ cfg, agentLlmFactory: stubFactory }); });
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await pool.end(); });

describe('POST /v1/cron/abe-shift', () => {
  it('rejects without the cron secret', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/cron/abe-shift' });
    expect(res.statusCode).toBe(401);
  });

  it('runs enabled goals and creates proposed plays', async () => {
    const t = await createTenant(pool);
    await pool.query(
      `INSERT INTO agent_configs (tenant_id, enabled, model, openai_key_encrypted) VALUES ($1, true, 'gpt-4.1', $2)`,
      [t.id, encrypt('sk-test', Buffer.from(encKeyB64, 'base64'))],
    );
    await upsertGoal(pool, t.id, { enabled: true });
    await pool.query(
      `INSERT INTO contacts (tenant_id, email, created_at) VALUES ($1, 'd@x.io', now() - make_interval(days => 100))`,
      [t.id],
    );

    const res = await app.inject({
      method: 'POST', url: '/v1/cron/abe-shift',
      headers: { 'x-cron-secret': 'c'.repeat(24) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().proposed).toBe(1);
    expect(await listPlays(pool, t.id)).toHaveLength(1);
  });
});
