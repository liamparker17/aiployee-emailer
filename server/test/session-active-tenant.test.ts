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

async function loginAs(email: string, password: string) {
  const csrf = await csrfFor(app);
  return login(app, { email, password }, csrf);
}

describe('POST /api/session/active-tenant', () => {
  it('super-admin sets active tenant and tenant-scoped routes work', async () => {
    const tenant = await createTenant(pool, 'Acme');
    await createUser(pool, { tenantId: null, email: 'admin@example.com', password: 'pw12345678', role: 'super_admin' });
    const headers = await loginAs('admin@example.com', 'pw12345678');
    const r = await app.inject({
      method: 'POST', url: '/api/session/active-tenant',
      headers, payload: { tenantId: tenant.id },
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, tenantId: tenant.id });
    // Confirm context flips by hitting a tenant-scoped GET.
    const senders = await app.inject({ method: 'GET', url: '/api/senders', headers });
    expect(senders.statusCode).toBe(200);
  });

  it('rejects unknown tenant id with 404', async () => {
    await createUser(pool, { tenantId: null, email: 'admin@example.com', password: 'pw12345678', role: 'super_admin' });
    const headers = await loginAs('admin@example.com', 'pw12345678');
    const r = await app.inject({
      method: 'POST', url: '/api/session/active-tenant',
      headers, payload: { tenantId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(r.statusCode).toBe(404);
  });

  it('lets a tenant member activate their own tenant (so the picker/gate work)', async () => {
    const t = await createTenant(pool, 'Acme2');
    await createUser(pool, { tenantId: t.id, email: 'user@example.com', password: 'pw12345678', role: 'tenant_admin' });
    const headers = await loginAs('user@example.com', 'pw12345678');
    const r = await app.inject({
      method: 'POST', url: '/api/session/active-tenant',
      headers, payload: { tenantId: t.id },
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, tenantId: t.id });
    // And tenant-scoped routes work for them.
    const senders = await app.inject({ method: 'GET', url: '/api/senders', headers });
    expect(senders.statusCode).toBe(200);
  });

  it('forbids a tenant member from activating a different tenant', async () => {
    const own = await createTenant(pool, 'OwnCo');
    const other = await createTenant(pool, 'OtherCo');
    await createUser(pool, { tenantId: own.id, email: 'user@example.com', password: 'pw12345678', role: 'tenant_admin' });
    const headers = await loginAs('user@example.com', 'pw12345678');
    const r = await app.inject({
      method: 'POST', url: '/api/session/active-tenant',
      headers, payload: { tenantId: other.id },
    });
    expect(r.statusCode).toBe(403);
  });

  it('blocks tenant-scoped routes when super-admin has no active tenant', async () => {
    await createUser(pool, { tenantId: null, email: 'admin@example.com', password: 'pw12345678', role: 'super_admin' });
    const headers = await loginAs('admin@example.com', 'pw12345678');
    const r = await app.inject({ method: 'GET', url: '/api/senders', headers });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error.code).toBe('no_active_tenant');
  });

  it('DELETE clears active tenant: POST then DELETE then GET returns null', async () => {
    const tenant = await createTenant(pool, 'Acme3');
    await createUser(pool, { tenantId: null, email: 'admin@example.com', password: 'pw12345678', role: 'super_admin' });
    const headers = await loginAs('admin@example.com', 'pw12345678');

    const setR = await app.inject({
      method: 'POST', url: '/api/session/active-tenant',
      headers, payload: { tenantId: tenant.id },
    });
    expect(setR.statusCode).toBe(200);

    const delR = await app.inject({ method: 'DELETE', url: '/api/session/active-tenant', headers });
    expect(delR.statusCode).toBe(200);
    expect(JSON.parse(delR.body)).toEqual({ ok: true });

    const getR = await app.inject({ method: 'GET', url: '/api/session/active-tenant', headers });
    expect(getR.statusCode).toBe(200);
    expect(JSON.parse(getR.body)).toEqual({ tenantId: null });
  });

  it('returns 4xx for malformed uuid body', async () => {
    await createUser(pool, { tenantId: null, email: 'admin@example.com', password: 'pw12345678', role: 'super_admin' });
    const headers = await loginAs('admin@example.com', 'pw12345678');
    const r = await app.inject({
      method: 'POST', url: '/api/session/active-tenant',
      headers, payload: { tenantId: 'not-a-uuid' },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
  });
});

describe('GET /api/session/tenants', () => {
  it('returns ALL tenants for a super-admin', async () => {
    await createTenant(pool, 'One');
    await createTenant(pool, 'Two');
    await createUser(pool, { tenantId: null, email: 'admin@example.com', password: 'pw12345678', role: 'super_admin' });
    const headers = await loginAs('admin@example.com', 'pw12345678');
    const r = await app.inject({ method: 'GET', url: '/api/session/tenants', headers });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).tenants).toHaveLength(2);
  });

  it('returns ONLY their own tenant for a tenant member (fixes "no access" on a new admin)', async () => {
    const own = await createTenant(pool, 'Mine');
    await createTenant(pool, 'NotMine');
    await createUser(pool, { tenantId: own.id, email: 'member@example.com', password: 'pw12345678', role: 'tenant_admin' });
    const headers = await loginAs('member@example.com', 'pw12345678');
    const r = await app.inject({ method: 'GET', url: '/api/session/tenants', headers });
    expect(r.statusCode).toBe(200);
    const tenants = JSON.parse(r.body).tenants;
    expect(tenants).toHaveLength(1);
    expect(tenants[0].id).toBe(own.id);
  });
});
