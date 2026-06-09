import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '@aiployee/core';
import { makePool, truncateAll } from './helpers/db.js';
import { createUser, createTenant } from './helpers/factories.js';
import { createInvitedUser } from '@aiployee/core';
import { csrfFor } from './helpers/auth.js';

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

async function csrfHeaders() {
  const csrf = await csrfFor(app);
  return { cookie: csrf.cookie, 'x-csrf-token': csrf.csrfToken };
}

describe('auth', () => {
  it('logs in valid super_admin', async () => {
    await createUser(pool, { tenantId: null, email: 'root@x.com', password: 'pw12345!', role: 'super_admin' });
    const headers = await csrfHeaders();
    const r = await app.inject({
      method: 'POST', url: '/auth/login', headers,
      payload: { email: 'root@x.com', password: 'pw12345!' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ user: { email: 'root@x.com', role: 'super_admin' } });
  });

  it('login is case-insensitive on email (stored lowercase, typed any case)', async () => {
    await createUser(pool, { tenantId: null, email: 'simon@aiployee.co.za', password: 'pw12345!', role: 'super_admin' });
    const headers = await csrfHeaders();
    const r = await app.inject({
      method: 'POST', url: '/auth/login', headers,
      payload: { email: 'Simon@Aiployee.co.za', password: 'pw12345!' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ user: { role: 'super_admin' } });
  });

  it('invited emails are stored lowercase', async () => {
    const { user } = await createInvitedUser(pool, { tenantId: null, email: 'MixedCase@Example.com', role: 'super_admin' });
    expect(user.email).toBe('mixedcase@example.com');
  });

  it('an email with both a super_admin and a tenant_admin row logs in by which password matches (super_admin preferred)', async () => {
    const t = await createTenant(pool);
    await createUser(pool, { tenantId: t.id, email: 'dup@x.com', password: 'tenantpw1', role: 'tenant_admin' });
    await createUser(pool, { tenantId: null, email: 'dup@x.com', password: 'superpw1', role: 'super_admin' });
    const headers = await csrfHeaders();
    const asSuper = await app.inject({ method: 'POST', url: '/auth/login', headers, payload: { email: 'dup@x.com', password: 'superpw1' } });
    expect(asSuper.statusCode).toBe(200);
    expect(asSuper.json().user.role).toBe('super_admin');
    const asTenant = await app.inject({ method: 'POST', url: '/auth/login', headers, payload: { email: 'dup@x.com', password: 'tenantpw1' } });
    expect(asTenant.statusCode).toBe(200);
    expect(asTenant.json().user.role).toBe('tenant_admin');
  });

  it('rejects bad password', async () => {
    await createUser(pool, { tenantId: null, email: 'root@x.com', password: 'pw12345!', role: 'super_admin' });
    const headers = await csrfHeaders();
    const r = await app.inject({
      method: 'POST', url: '/auth/login', headers,
      payload: { email: 'root@x.com', password: 'wrong' },
    });
    expect(r.statusCode).toBe(401);
  });

  it('accepts an invite, persists the password, and the user can log in', async () => {
    const t = await createTenant(pool);
    const { user, inviteToken } = await createInvitedUser(pool, { tenantId: t.id, email: 'new@x.com', role: 'tenant_admin' });
    const headers = await csrfHeaders();

    const accept = await app.inject({ method: 'POST', url: '/auth/invite/accept', headers, payload: { token: inviteToken, password: 'brandnew123' } });
    expect(accept.statusCode).toBe(200);

    const row = await pool.query<{ invite_token: string | null }>('SELECT invite_token FROM users WHERE id = $1', [user.id]);
    expect(row.rows[0].invite_token).toBeNull(); // token consumed

    const login = await app.inject({ method: 'POST', url: '/auth/login', headers, payload: { email: 'new@x.com', password: 'brandnew123' } });
    expect(login.statusCode).toBe(200);
  });

  it('accepts an invite WITHOUT a CSRF token (token is the auth; fixes the magic-link race)', async () => {
    const t = await createTenant(pool);
    const { inviteToken } = await createInvitedUser(pool, { tenantId: t.id, email: 'noc@x.com', role: 'tenant_admin' });
    // No CSRF headers — this 403'd before the exemption, blocking invite acceptance.
    const accept = await app.inject({ method: 'POST', url: '/auth/invite/accept', payload: { token: inviteToken, password: 'brandnew123' } });
    expect(accept.statusCode).toBe(200);
  });
});
