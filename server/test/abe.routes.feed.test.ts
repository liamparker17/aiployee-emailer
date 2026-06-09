import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant, createUser } from './helpers/factories.js';
import { csrfFor, login } from './helpers/auth.js';

const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
  CRON_SECRET: 'c'.repeat(24),
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

describe('GET /api/agent/feed', () => {
  it('requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agent/feed' });
    expect(res.statusCode).toBe(401);
  });

  it('returns derived feed entries for the tenant', async () => {
    const { tenantId, headers } = await adminSession();
    const goal = await pool.query<{ id: string }>(
      `INSERT INTO agent_goals (tenant_id, enabled) VALUES ($1, true) RETURNING id`, [tenantId]);
    await pool.query(
      `INSERT INTO agent_plays (tenant_id, goal_id, status, audience_snapshot, touches)
       VALUES ($1, $2, 'proposed', '{"contact_ids":[],"size":7}', '[]')`, [tenantId, goal.rows[0].id]);

    const res = await app.inject({ method: 'GET', url: '/api/agent/feed', headers });
    expect(res.statusCode).toBe(200);
    const feed = res.json().feed;
    expect(Array.isArray(feed)).toBe(true);
    expect(feed[0].kind).toBe('proposed');
    expect(feed[0].text).toContain('7');
  });
});
