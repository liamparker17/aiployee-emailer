import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '@aiployee/core';
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

describe('GET /api/agent/plays/:id with outcomes', () => {
  it('returns the play plus its outcome rows', async () => {
    const { tenantId, headers } = await adminSession();
    const goal = await pool.query<{ id: string }>(
      `INSERT INTO agent_goals (tenant_id, enabled) VALUES ($1, true) RETURNING id`, [tenantId]);
    const play = await pool.query<{ id: string }>(
      `INSERT INTO agent_plays (tenant_id, goal_id, status, audience_snapshot, touches)
       VALUES ($1, $2, 'done', '{"contact_ids":[],"size":3}', '[]') RETURNING id`, [tenantId, goal.rows[0].id]);
    await pool.query(
      `INSERT INTO agent_play_outcomes (play_id, tenant_id, touch_index, sends, opens, reactivations)
       VALUES ($1, $2, 0, 3, 2, 1)`, [play.rows[0].id, tenantId]);

    const res = await app.inject({ method: 'GET', url: `/api/agent/plays/${play.rows[0].id}`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().play.id).toBe(play.rows[0].id);
    expect(Array.isArray(res.json().outcomes)).toBe(true);
    expect(res.json().outcomes[0].sends).toBe(3);
    expect(res.json().outcomes[0].reactivations).toBe(1);
  });

  it('404s for an unknown play', async () => {
    const { headers } = await adminSession();
    const res = await app.inject({
      method: 'GET', url: '/api/agent/plays/00000000-0000-0000-0000-000000000000', headers });
    expect(res.statusCode).toBe(404);
  });
});
