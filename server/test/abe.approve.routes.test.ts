import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '@aiployee/core';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant, createUser } from './helpers/factories.js';
import { csrfFor, login } from './helpers/auth.js';
import { upsertGoal } from '../src/repos/agentGoals.js';
import { insertPlay } from '../src/repos/agentPlays.js';

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
  return { tenantId: t.id, headers, csrf };
}

async function defSender(tenantId: string) {
  const cfgRow = await pool.query(
    `INSERT INTO smtp_configs (tenant_id, name, host, port, secure, username, password_encrypted, from_domain)
     VALUES ($1,'def','h',25,false,'u','\\x00','x.io') RETURNING id`, [tenantId]);
  await pool.query(
    `INSERT INTO senders (tenant_id, email, display_name, smtp_config_id, is_default)
     VALUES ($1,'from@x.io','X',$2,true)`, [tenantId, cfgRow.rows[0].id]);
}

async function contact(tenantId: string, email: string) {
  const r = await pool.query(`INSERT INTO contacts (tenant_id, email) VALUES ($1,$2) RETURNING id`, [tenantId, email]);
  return r.rows[0].id as string;
}

async function proposedPlay(tenantId: string, ids: string[]) {
  const g = await upsertGoal(pool, tenantId, { enabled: true });
  return insertPlay(pool, { tenantId, goalId: g.id, riskScore: ids.length,
    audienceSnapshot: { contact_ids: ids, size: ids.length },
    touches: [{ index: 0, subject: 'Miss you', body_html: '<p>hi</p>', scheduled_offset_days: 0 }] });
}

describe('abe approve/reject routes', () => {
  it('approve starts execution', async () => {
    const { tenantId, headers, csrf } = await adminSession();
    await defSender(tenantId);
    const c1 = await contact(tenantId, 'a@x.io');
    const play = await proposedPlay(tenantId, [c1]);
    const res = await app.inject({
      method: 'POST', url: `/api/agent/plays/${play.id}/approve`,
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().play.status).toBe('executing');
    expect(res.json().queued).toBe(1);
  });

  it('reject marks the play rejected with reason', async () => {
    const { tenantId, headers, csrf } = await adminSession();
    const c1 = await contact(tenantId, 'a@x.io');
    const play = await proposedPlay(tenantId, [c1]);
    const res = await app.inject({
      method: 'POST', url: `/api/agent/plays/${play.id}/reject`,
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken }, payload: { reason: 'not now' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().play.status).toBe('rejected');
    expect(res.json().play.rejection_reason).toBe('not now');
  });
});
