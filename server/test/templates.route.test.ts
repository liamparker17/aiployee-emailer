import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
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

async function loginTenantAdmin(tenantId: string, email = 'a@x.com') {
  await createUser(pool, { tenantId, email, password: 'pw12345!', role: 'tenant_admin' });
  const csrf = await csrfFor(app);
  return login(app, { email, password: 'pw12345!' }, csrf);
}

describe('templates routes', () => {
  it('creates, lists, previews, and isolates by tenant', async () => {
    const a = await createTenant(pool); const b = await createTenant(pool);
    const headersA = await loginTenantAdmin(a.id);
    const create = await app.inject({
      method: 'POST', url: '/api/templates', headers: headersA,
      payload: { name: 'welcome', subject: 'Hi {{name}}', bodyHtml: '<p>Hello {{name}}</p>' },
    });
    expect(create.statusCode).toBe(201);
    const tplId = create.json().template.id;

    const list = await app.inject({ method: 'GET', url: '/api/templates', headers: headersA });
    expect(list.json().templates).toHaveLength(1);

    const preview = await app.inject({
      method: 'POST', url: `/api/templates/${tplId}/preview`, headers: headersA,
      payload: { variables: { name: 'Alex' } },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().html).toContain('Hello Alex');

    const headersB = await loginTenantAdmin(b.id, 'b@x.com');
    const listB = await app.inject({ method: 'GET', url: '/api/templates', headers: headersB });
    expect(listB.json().templates).toHaveLength(0);
  });

  it('accepts displayName on create and clears it on patch', async () => {
    const a = await createTenant(pool);
    const headersA = await loginTenantAdmin(a.id);
    const create = await app.inject({
      method: 'POST', url: '/api/templates', headers: headersA,
      payload: { name: 'absa_line', subject: 'S', bodyHtml: '<p>x</p>', displayName: '  First Assist Absa Line  ' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().template.display_name).toBe('First Assist Absa Line'); // zod-trimmed
    const tplId = create.json().template.id;

    const patchOmit = await app.inject({
      method: 'PATCH', url: `/api/templates/${tplId}`, headers: headersA,
      payload: { subject: 'S2' },
    });
    expect(patchOmit.json().template.display_name).toBe('First Assist Absa Line'); // omit preserves

    const patchClear = await app.inject({
      method: 'PATCH', url: `/api/templates/${tplId}`, headers: headersA,
      payload: { displayName: null },
    });
    expect(patchClear.json().template.display_name).toBeNull(); // null clears
  });
});
