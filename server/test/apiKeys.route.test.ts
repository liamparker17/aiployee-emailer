import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createUser, createTenant } from './helpers/factories.js';
import { csrfFor, login } from './helpers/auth.js';
import { insertApiKey } from '../src/repos/apiKeys.js';
import { generateApiKey, hashApiKey, prefixOf } from '../src/auth/apiKey.js';

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

async function loginTenantAdmin(tenantId: string) {
  await createUser(pool, { tenantId, email: 'a@x.com', password: 'pw12345!', role: 'tenant_admin' });
  const csrf = await csrfFor(app);
  return login(app, { email: 'a@x.com', password: 'pw12345!' }, csrf);
}

async function createKey(headers: Record<string, string>, name: string, parentId?: string) {
  const r = await app.inject({
    method: 'POST', url: '/api/api-keys', headers,
    payload: parentId ? { name, parentId } : { name },
  });
  return r;
}

describe('api keys routes', () => {
  it('creates, lists (no plaintext), and revokes', async () => {
    const t = await createTenant(pool);
    const headers = await loginTenantAdmin(t.id);
    const create = await app.inject({
      method: 'POST', url: '/api/api-keys', headers, payload: { name: 'workflow-1' },
    });
    expect(create.statusCode).toBe(201);
    const body = create.json();
    expect(body.plaintext.startsWith('aip_live_')).toBe(true);
    expect(body.key.key_prefix).toBe(body.plaintext.slice(0, 13));
    expect(body.key.parent_id).toBeNull();

    const list = await app.inject({ method: 'GET', url: '/api/api-keys', headers });
    expect(list.json().keys[0]).not.toHaveProperty('key_hash');

    const id = body.key.id;
    const del = await app.inject({ method: 'DELETE', url: `/api/api-keys/${id}`, headers });
    expect(del.statusCode).toBe(200);
    const list2 = await app.inject({ method: 'GET', url: '/api/api-keys', headers });
    expect(list2.json().keys[0].revoked_at).toBeTruthy();
  });

  it('creates a sub-key under a master key', async () => {
    const t = await createTenant(pool);
    const headers = await loginTenantAdmin(t.id);
    const master = (await createKey(headers, 'master')).json();
    const sub = await createKey(headers, 'cold-outreach', master.key.id);
    expect(sub.statusCode).toBe(201);
    expect(sub.json().key.parent_id).toBe(master.key.id);
    expect(sub.json().plaintext.startsWith('aip_live_')).toBe(true);

    const keys = (await app.inject({ method: 'GET', url: '/api/api-keys', headers })).json().keys;
    expect(keys).toHaveLength(2);
    const byId = Object.fromEntries(keys.map((k: { id: string }) => [k.id, k]));
    expect(byId[master.key.id].parent_id).toBeNull();
    expect(byId[sub.json().key.id].parent_id).toBe(master.key.id);
  });

  it('rejects a sub-key whose parent is itself a sub-key (one level deep)', async () => {
    const t = await createTenant(pool);
    const headers = await loginTenantAdmin(t.id);
    const master = (await createKey(headers, 'master')).json();
    const sub = (await createKey(headers, 'sub', master.key.id)).json();
    const r = await createKey(headers, 'sub-of-sub', sub.key.id);
    expect(r.statusCode).toBe(400);
  });

  it('rejects a parent key from another tenant', async () => {
    const t1 = await createTenant(pool);
    const t2 = await createTenant(pool);
    const headers1 = await loginTenantAdmin(t1.id);
    // Master key owned by t2, created directly via the repo.
    const k = generateApiKey();
    const foreign = await insertApiKey(pool, { tenantId: t2.id, name: 'foreign', keyHash: hashApiKey(k), keyPrefix: prefixOf(k) });
    const r = await createKey(headers1, 'sub', foreign.id);
    expect(r.statusCode).toBe(404);
  });

  it('rejects a sub-key under a revoked parent', async () => {
    const t = await createTenant(pool);
    const headers = await loginTenantAdmin(t.id);
    const master = (await createKey(headers, 'master')).json();
    await app.inject({ method: 'DELETE', url: `/api/api-keys/${master.key.id}`, headers });
    const r = await createKey(headers, 'sub', master.key.id);
    expect(r.statusCode).toBe(400);
  });

  it('revoking a master cascades to its sub-keys', async () => {
    const t = await createTenant(pool);
    const headers = await loginTenantAdmin(t.id);
    const master = (await createKey(headers, 'master')).json();
    const sub1 = (await createKey(headers, 'sub1', master.key.id)).json();
    const sub2 = (await createKey(headers, 'sub2', master.key.id)).json();

    const del = await app.inject({ method: 'DELETE', url: `/api/api-keys/${master.key.id}`, headers });
    expect(del.statusCode).toBe(200);

    const keys = (await app.inject({ method: 'GET', url: '/api/api-keys', headers })).json().keys;
    const byId = Object.fromEntries(keys.map((k: { id: string }) => [k.id, k]));
    expect(byId[master.key.id].revoked_at).toBeTruthy();
    expect(byId[sub1.key.id].revoked_at).toBeTruthy();
    expect(byId[sub2.key.id].revoked_at).toBeTruthy();
  });

  it('revoking a sub-key leaves the master and siblings active', async () => {
    const t = await createTenant(pool);
    const headers = await loginTenantAdmin(t.id);
    const master = (await createKey(headers, 'master')).json();
    const sub1 = (await createKey(headers, 'sub1', master.key.id)).json();
    const sub2 = (await createKey(headers, 'sub2', master.key.id)).json();

    const del = await app.inject({ method: 'DELETE', url: `/api/api-keys/${sub1.key.id}`, headers });
    expect(del.statusCode).toBe(200);

    const keys = (await app.inject({ method: 'GET', url: '/api/api-keys', headers })).json().keys;
    const byId = Object.fromEntries(keys.map((k: { id: string }) => [k.id, k]));
    expect(byId[sub1.key.id].revoked_at).toBeTruthy();
    expect(byId[master.key.id].revoked_at).toBeNull();
    expect(byId[sub2.key.id].revoked_at).toBeNull();
  });
});
