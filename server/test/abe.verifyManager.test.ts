import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '@aiployee/core';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant, createUser } from './helpers/factories.js';
import { csrfFor, login } from './helpers/auth.js';
import { createSmtpConfig } from '@aiployee/core';
import { createSender } from '@aiployee/core';
import { startTestSmtp } from './helpers/smtp.js';
import { getGoal, upsertGoal } from '../src/repos/agentGoals.js';
import { signApprovalToken } from '../src/agent/abe/approvalToken.js';

const KEY = Buffer.alloc(32, 1);
const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: KEY.toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
  CRON_SECRET: 'c'.repeat(24),
});

let app: Awaited<ReturnType<typeof buildApp>>;
let smtp: ReturnType<typeof startTestSmtp>;
const pool = makePool();

beforeAll(async () => { smtp = startTestSmtp(2532); app = await buildApp({ cfg }); });
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await smtp.close(); await pool.end(); });

async function adminWithSender() {
  const t = await createTenant(pool);
  const sc = await createSmtpConfig(pool, KEY, {
    tenantId: t.id, name: 'local', host: '127.0.0.1', port: 2532, secure: false,
    username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
  });
  await createSender(pool, { tenantId: t.id, email: 'abe@x.com', displayName: 'Abe', smtpConfigId: sc.id, isDefault: true });
  const password = 'pw-12345678';
  await createUser(pool, { tenantId: t.id, email: 'admin@x.io', password, role: 'tenant_admin' });
  const csrf = await csrfFor(app);
  const headers = await login(app, { email: 'admin@x.io', password }, csrf);
  return { tenantId: t.id, headers, csrf };
}

describe('manager verify', () => {
  it('session POST sends a verify email to the configured manager', async () => {
    const { tenantId, headers, csrf } = await adminWithSender();
    await upsertGoal(pool, tenantId, { enabled: true, lineManagerEmail: 'boss@x.io' });
    const recv = smtp.lastMail();
    const r = await app.inject({
      method: 'POST', url: '/api/agent/goals/verify-manager',
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().sent).toBe(true);
    const mail = await recv as { headers: Record<string, string> };
    expect(mail.headers.to).toContain('boss@x.io');
  });

  it('session POST 400s when no manager email is set', async () => {
    const { tenantId, headers, csrf } = await adminWithSender();
    await upsertGoal(pool, tenantId, { enabled: true });
    const r = await app.inject({
      method: 'POST', url: '/api/agent/goals/verify-manager',
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
    });
    expect(r.statusCode).toBe(400);
  });

  it('public verify route sets line_manager_verified_at and is HTML', async () => {
    const t = await createTenant(pool);
    await upsertGoal(pool, t.id, { enabled: true, lineManagerEmail: 'boss@x.io' });
    const token = signApprovalToken(t.id, Date.now() + 60_000, KEY);
    const r = await app.inject({ method: 'GET', url: `/v1/agent/verify-manager/${encodeURIComponent(token)}` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    const goal = await getGoal(pool, t.id);
    expect(goal!.line_manager_verified_at).not.toBeNull();
  });

  it('public verify route rejects an expired/invalid token (400 HTML, no change)', async () => {
    const t = await createTenant(pool);
    await upsertGoal(pool, t.id, { enabled: true, lineManagerEmail: 'boss@x.io' });
    const expired = signApprovalToken(t.id, Date.now() - 1, KEY);
    const r = await app.inject({ method: 'GET', url: `/v1/agent/verify-manager/${encodeURIComponent(expired)}` });
    expect(r.statusCode).toBe(400);
    const goal = await getGoal(pool, t.id);
    expect(goal!.line_manager_verified_at).toBeNull();
  });
});
