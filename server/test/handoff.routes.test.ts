import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '@aiployee/core';
import { makePool, truncateAll } from './helpers/db.js';
import { createUser, createTenant } from './helpers/factories.js';
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

const CC_ORIGIN = 'https://aiployee-command-centre.vercel.app';

async function loginAdmin(tenantId: string) {
  await createUser(pool, { tenantId, email: 'a@x.com', password: 'pw12345!', role: 'tenant_admin' });
  const csrf = await csrfFor(app);
  return login(app, { email: 'a@x.com', password: 'pw12345!' }, csrf);
}

describe('cross-app handoff SSO', () => {
  it('rejects /auth/handoff without a session (401)', async () => {
    const r = await app.inject({ method: 'GET', url: `/auth/handoff?to=${encodeURIComponent(CC_ORIGIN)}` });
    expect(r.statusCode).toBe(401);
  });

  it('rejects a disallowed destination (400)', async () => {
    const t = await createTenant(pool);
    const h = await loginAdmin(t.id);
    const r = await app.inject({
      method: 'GET',
      url: `/auth/handoff?to=${encodeURIComponent('https://evil.example.com')}`,
      headers: { cookie: h.cookie },
    });
    expect(r.statusCode).toBe(400);
  });

  it('issues a token; the round-trip establishes a session; replay is rejected', async () => {
    const t = await createTenant(pool);
    const h = await loginAdmin(t.id);

    const issued = await app.inject({
      method: 'GET',
      url: `/auth/handoff?to=${encodeURIComponent(CC_ORIGIN)}`,
      headers: { cookie: h.cookie },
    });
    expect(issued.statusCode).toBe(302);
    const loc = issued.headers.location as string;
    expect(loc).toContain(`${CC_ORIGIN}/auth/handoff/accept?token=`);
    const token = new URL(loc).searchParams.get('token')!;
    expect(token).toBeTruthy();

    // Accept on a fresh client (no cookie) → 302 home + new session cookie.
    const accepted = await app.inject({ method: 'GET', url: `/auth/handoff/accept?token=${encodeURIComponent(token)}` });
    expect(accepted.statusCode).toBe(302);
    expect(accepted.headers.location).toBe('/');
    const setCookie = ([] as string[]).concat(accepted.headers['set-cookie'] as string | string[]).filter(Boolean);
    expect(setCookie.some((c) => c.startsWith('aip_sid='))).toBe(true);

    // Replaying the same token is rejected (single-use jti).
    const replay = await app.inject({ method: 'GET', url: `/auth/handoff/accept?token=${encodeURIComponent(token)}` });
    expect(replay.statusCode).toBe(401);
  });

  it('rejects a forged token (401)', async () => {
    const r = await app.inject({ method: 'GET', url: `/auth/handoff/accept?token=not.avalidtoken` });
    expect(r.statusCode).toBe(401);
  });
});
