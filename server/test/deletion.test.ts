import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant, createUser } from './helpers/factories.js';
import { csrfFor, login } from './helpers/auth.js';
import { createSmtpConfig } from '../src/repos/smtpConfigs.js';
import { createSender } from '../src/repos/senders.js';
import { insertApiKey, revokeApiKey, deleteApiKeyPermanent } from '../src/repos/apiKeys.js';
import { generateApiKey, hashApiKey, prefixOf } from '../src/auth/apiKey.js';

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
const pool = makePool();
beforeAll(async () => { app = await buildApp({ cfg }); });
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await pool.end(); });

async function loginAs(email: string, password: string) {
  const csrf = await csrfFor(app);
  return login(app, { email, password }, csrf);
}
async function superAdminWithActiveTenant(tenantId: string) {
  await createUser(pool, { tenantId: null, email: 'super@x.com', password: 'pw12345678', role: 'super_admin' });
  const headers = await loginAs('super@x.com', 'pw12345678');
  await app.inject({ method: 'POST', url: '/api/session/active-tenant', headers, payload: { tenantId } });
  return headers;
}

describe('DELETE /api/admin/tenants/:id', () => {
  it('super-admin deletes a tenant and all its data + sessions', async () => {
    const t = await createTenant(pool, 'DoomedCo');
    // a tenant member who has logged in (so a session row exists)
    await createUser(pool, { tenantId: t.id, email: 'member@x.com', password: 'pw12345678', role: 'tenant_admin' });
    await loginAs('member@x.com', 'pw12345678');
    const k = generateApiKey();
    await insertApiKey(pool, { tenantId: t.id, name: 'k', keyHash: hashApiKey(k), keyPrefix: prefixOf(k) });

    const headers = await superAdminWithActiveTenant(t.id);
    const del = await app.inject({ method: 'DELETE', url: `/api/admin/tenants/${t.id}`, headers });
    expect(del.statusCode).toBe(200);

    expect((await pool.query('SELECT 1 FROM tenants WHERE id=$1', [t.id])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM users WHERE tenant_id=$1', [t.id])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM api_keys WHERE tenant_id=$1', [t.id])).rowCount).toBe(0);
    expect((await pool.query(`SELECT 1 FROM sessions WHERE sess->>'tenantId'=$1`, [t.id])).rowCount).toBe(0);
  });

  it('rejects a non-super-admin (tenant_admin) with 403', async () => {
    const t = await createTenant(pool, 'Acme');
    await createUser(pool, { tenantId: t.id, email: 'admin@x.com', password: 'pw12345678', role: 'tenant_admin' });
    const headers = await loginAs('admin@x.com', 'pw12345678');
    const del = await app.inject({ method: 'DELETE', url: `/api/admin/tenants/${t.id}`, headers });
    expect(del.statusCode).toBe(403);
    expect((await pool.query('SELECT 1 FROM tenants WHERE id=$1', [t.id])).rowCount).toBe(1);
  });

  it('404 for unknown tenant', async () => {
    const t = await createTenant(pool, 'Acme');
    const headers = await superAdminWithActiveTenant(t.id);
    const del = await app.inject({ method: 'DELETE', url: '/api/admin/tenants/00000000-0000-0000-0000-000000000000', headers });
    expect(del.statusCode).toBe(404);
  });
});

describe('DELETE /api/users/:id', () => {
  it('tenant_admin deletes a tenant_user and clears their session', async () => {
    const t = await createTenant(pool);
    await createUser(pool, { tenantId: t.id, email: 'admin@x.com', password: 'pw12345678', role: 'tenant_admin' });
    const victim = await createUser(pool, { tenantId: t.id, email: 'victim@x.com', password: 'pw12345678', role: 'tenant_user' });
    await loginAs('victim@x.com', 'pw12345678'); // creates a session for victim
    const headers = await loginAs('admin@x.com', 'pw12345678');

    const del = await app.inject({ method: 'DELETE', url: `/api/users/${victim.id}`, headers });
    expect(del.statusCode).toBe(200);
    expect((await pool.query('SELECT 1 FROM users WHERE id=$1', [victim.id])).rowCount).toBe(0);
    expect((await pool.query(`SELECT 1 FROM sessions WHERE sess->>'userId'=$1`, [victim.id])).rowCount).toBe(0);
  });

  it('cannot delete yourself (400)', async () => {
    const t = await createTenant(pool);
    const me = await createUser(pool, { tenantId: t.id, email: 'admin@x.com', password: 'pw12345678', role: 'tenant_admin' });
    const headers = await loginAs('admin@x.com', 'pw12345678');
    const del = await app.inject({ method: 'DELETE', url: `/api/users/${me.id}`, headers });
    expect(del.statusCode).toBe(400);
    expect((await pool.query('SELECT 1 FROM users WHERE id=$1', [me.id])).rowCount).toBe(1);
  });

  it('cannot delete the last tenant_admin (400)', async () => {
    const t = await createTenant(pool);
    const onlyAdmin = await createUser(pool, { tenantId: t.id, email: 'admin@x.com', password: 'pw12345678', role: 'tenant_admin' });
    const headers = await superAdminWithActiveTenant(t.id);
    const del = await app.inject({ method: 'DELETE', url: `/api/users/${onlyAdmin.id}`, headers });
    expect(del.statusCode).toBe(400);
    expect((await pool.query('SELECT 1 FROM users WHERE id=$1', [onlyAdmin.id])).rowCount).toBe(1);
  });

  it('cannot delete a user in another tenant (404)', async () => {
    const t1 = await createTenant(pool, 'T1');
    const t2 = await createTenant(pool, 'T2');
    await createUser(pool, { tenantId: t1.id, email: 'admin@x.com', password: 'pw12345678', role: 'tenant_admin' });
    const foreign = await createUser(pool, { tenantId: t2.id, email: 'foreign@x.com', password: 'pw12345678', role: 'tenant_user' });
    const headers = await loginAs('admin@x.com', 'pw12345678');
    const del = await app.inject({ method: 'DELETE', url: `/api/users/${foreign.id}`, headers });
    expect(del.statusCode).toBe(404);
    expect((await pool.query('SELECT 1 FROM users WHERE id=$1', [foreign.id])).rowCount).toBe(1);
  });

  it('a tenant_user cannot delete users (403)', async () => {
    const t = await createTenant(pool);
    await createUser(pool, { tenantId: t.id, email: 'admin@x.com', password: 'pw12345678', role: 'tenant_admin' });
    const u = await createUser(pool, { tenantId: t.id, email: 'user@x.com', password: 'pw12345678', role: 'tenant_user' });
    const headers = await loginAs('user@x.com', 'pw12345678');
    const del = await app.inject({ method: 'DELETE', url: `/api/users/${u.id}`, headers });
    expect(del.statusCode).toBe(403);
  });
});

describe('DELETE /api/api-keys/:id/permanent', () => {
  async function tenantAdminHeaders() {
    const t = await createTenant(pool);
    await createUser(pool, { tenantId: t.id, email: 'admin@x.com', password: 'pw12345678', role: 'tenant_admin' });
    const headers = await loginAs('admin@x.com', 'pw12345678');
    return { t, headers };
  }

  it('permanently deletes a revoked key', async () => {
    const { headers } = await tenantAdminHeaders();
    const created = (await app.inject({ method: 'POST', url: '/api/api-keys', headers, payload: { name: 'k' } })).json();
    await app.inject({ method: 'DELETE', url: `/api/api-keys/${created.key.id}`, headers }); // revoke
    const del = await app.inject({ method: 'DELETE', url: `/api/api-keys/${created.key.id}/permanent`, headers });
    expect(del.statusCode).toBe(200);
    const list = (await app.inject({ method: 'GET', url: '/api/api-keys', headers })).json();
    expect(list.keys.find((k: { id: string }) => k.id === created.key.id)).toBeUndefined();
  });

  it('refuses to hard-delete an active (non-revoked) key (404)', async () => {
    const { headers } = await tenantAdminHeaders();
    const created = (await app.inject({ method: 'POST', url: '/api/api-keys', headers, payload: { name: 'k' } })).json();
    const del = await app.inject({ method: 'DELETE', url: `/api/api-keys/${created.key.id}/permanent`, headers });
    expect(del.statusCode).toBe(404);
    const list = (await app.inject({ method: 'GET', url: '/api/api-keys', headers })).json();
    expect(list.keys.find((k: { id: string }) => k.id === created.key.id)).toBeDefined();
  });

  it('deleting a revoked master removes its sub-keys', async () => {
    const { headers } = await tenantAdminHeaders();
    const master = (await app.inject({ method: 'POST', url: '/api/api-keys', headers, payload: { name: 'master' } })).json();
    await app.inject({ method: 'POST', url: '/api/api-keys', headers, payload: { name: 'sub', parentId: master.key.id } });
    await app.inject({ method: 'DELETE', url: `/api/api-keys/${master.key.id}`, headers }); // revoke master (cascade revokes sub)
    const del = await app.inject({ method: 'DELETE', url: `/api/api-keys/${master.key.id}/permanent`, headers });
    expect(del.statusCode).toBe(200);
    const list = (await app.inject({ method: 'GET', url: '/api/api-keys', headers })).json();
    expect(list.keys).toHaveLength(0);
  });

  it('keeps email-log rows (api_key_id set NULL) when a used key is deleted', async () => {
    const t = await createTenant(pool);
    const sc = await createSmtpConfig(pool, KEY, {
      tenantId: t.id, name: 'local', host: '127.0.0.1', port: 2599, secure: false,
      username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
    });
    const s = await createSender(pool, { tenantId: t.id, email: 'a@x.com', displayName: 'A', smtpConfigId: sc.id });
    const plain = generateApiKey();
    const key = await insertApiKey(pool, { tenantId: t.id, name: 'k', keyHash: hashApiKey(plain), keyPrefix: prefixOf(plain) });
    const em = await pool.query<{ id: string }>(
      `INSERT INTO emails(tenant_id, sender_id, to_addr, subject, body_html, status, api_key_id)
       VALUES ($1,$2,'r@x.com','s','<p>x</p>','sent',$3) RETURNING id`,
      [t.id, s.id, key.id]);

    await revokeApiKey(pool, t.id, key.id);
    expect(await deleteApiKeyPermanent(pool, t.id, key.id)).toBe(true);

    const after = await pool.query<{ api_key_id: string | null }>('SELECT api_key_id FROM emails WHERE id=$1', [em.rows[0].id]);
    expect(after.rowCount).toBe(1);
    expect(after.rows[0].api_key_id).toBeNull();
  });
});
