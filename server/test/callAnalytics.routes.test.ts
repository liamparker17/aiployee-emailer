import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '@aiployee/core';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant, createUser } from './helpers/factories.js';
import { csrfFor, login } from './helpers/auth.js';
import { seedInboundCall } from './helpers/lineReport.js';
import { insertCallTag } from '../src/repos/lineCallTags.js';
import { upsertLineReportConfig } from '../src/repos/lineReportConfigs.js';
import { createSmtpConfig } from '../src/repos/smtpConfigs.js';
import { createSender } from '../src/repos/senders.js';

const KEY = Buffer.alloc(32, 1);
const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: KEY.toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
  CRON_SECRET: 'c'.repeat(24),
});

// Stub LLM: returns payload valid for both suggestCategories and retagCalls.
// suggestCategories reads .categories; lineTagger reads .tags[].
const STUB_CONTENT = JSON.stringify({
  categories: ['Claims'],
  tags: [{ ref: 1, category: 'Claims', severity: 'low', is_emerging: false }],
});
const llmStub = (_key?: string) => ({
  chat: async (_a: unknown) => ({ content: STUB_CONTENT }),
});

let app: Awaited<ReturnType<typeof buildApp>>;
const pool = makePool();

beforeAll(async () => {
  app = await buildApp({ cfg, agentLlmFactory: llmStub as never });
});
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

async function nonAdminSession(tenantId: string) {
  const password = 'pw-99999999';
  await createUser(pool, { tenantId, email: 'user@x.io', password, role: 'tenant_user' });
  const csrf = await csrfFor(app);
  const headers = await login(app, { email: 'user@x.io', password }, csrf);
  return { headers, csrf };
}

// ── GET /api/calls ─────────────────────────────────────────────────────────

describe('GET /api/calls', () => {
  it('returns 403 for non-admin', async () => {
    const { tenantId } = await adminSession();
    const { headers } = await nonAdminSession(tenantId);
    const res = await app.inject({ method: 'GET', url: '/api/calls', headers });
    expect(res.statusCode).toBe(403);
  });

  it('returns 200 with calls array and total for admin', async () => {
    const { tenantId, headers } = await adminSession();
    await seedInboundCall(pool, tenantId, 'Call about insurance claim');
    await seedInboundCall(pool, tenantId, 'Call about billing query');
    const res = await app.inject({ method: 'GET', url: '/api/calls', headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.calls)).toBe(true);
    expect(body.calls).toHaveLength(2);
    expect(typeof body.total).toBe('number');
    expect(body.total).toBe(2);
  });
});

// ── GET /api/calls/breakdown ───────────────────────────────────────────────

describe('GET /api/calls/breakdown', () => {
  it('returns breakdown with total=2 and byCategory/perDay arrays', async () => {
    const { tenantId, headers } = await adminSession();
    const c1 = await seedInboundCall(pool, tenantId, 'Claims call');
    const c2 = await seedInboundCall(pool, tenantId, 'Another claims call');
    await insertCallTag(pool, { tenantId, messageId: c1.id, category: 'Claims', severity: 'low', isEmerging: false });
    await insertCallTag(pool, { tenantId, messageId: c2.id, category: 'Claims', severity: 'low', isEmerging: false });

    const res = await app.inject({ method: 'GET', url: '/api/calls/breakdown?window=7d', headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.window).toBe('7d');
    expect(body.total).toBe(2);
    expect(Array.isArray(body.byCategory)).toBe(true);
    expect(Array.isArray(body.perDay)).toBe(true);
    expect(body.byCategory.some((b: { category: string }) => b.category === 'Claims')).toBe(true);
  });
});

// ── GET /api/calls/categories ──────────────────────────────────────────────

describe('GET /api/calls/categories', () => {
  it('returns empty array when no config exists', async () => {
    const { headers } = await adminSession();
    const res = await app.inject({ method: 'GET', url: '/api/calls/categories', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ categories: [] });
  });

  it('returns taxonomy from config', async () => {
    const { tenantId, headers } = await adminSession();
    await upsertLineReportConfig(pool, tenantId, { taxonomy: ['Claims', 'Billing'] });
    const res = await app.inject({ method: 'GET', url: '/api/calls/categories', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().categories).toEqual(['Claims', 'Billing']);
  });
});

// ── PUT /api/calls/categories ──────────────────────────────────────────────

describe('PUT /api/calls/categories', () => {
  it('saves and returns the new categories', async () => {
    const { headers, csrf } = await adminSession();
    const res = await app.inject({
      method: 'PUT', url: '/api/calls/categories',
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
      payload: { categories: ['A', 'B'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().categories).toEqual(['A', 'B']);
  });

  it('rejects empty category strings', async () => {
    const { headers, csrf } = await adminSession();
    const res = await app.inject({
      method: 'PUT', url: '/api/calls/categories',
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
      payload: { categories: [''] },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── POST /api/calls/suggest-categories ────────────────────────────────────

describe('POST /api/calls/suggest-categories', () => {
  it('returns suggested categories from the stub LLM', async () => {
    const { tenantId, headers, csrf } = await adminSession();
    // Seed a call so sampleInboundContents returns something non-empty.
    await seedInboundCall(pool, tenantId, 'Insurance claim for car accident');
    const res = await app.inject({
      method: 'POST', url: '/api/calls/suggest-categories',
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().suggested).toEqual(['Claims']);
  });
});

// ── POST /api/calls/retag ─────────────────────────────────────────────────

describe('POST /api/calls/retag', () => {
  it('returns retagged and remaining counts', async () => {
    const { tenantId, headers, csrf } = await adminSession();
    // Seed a call and a taxonomy so the tagger has something to tag.
    await seedInboundCall(pool, tenantId, 'Claim for water damage');
    await upsertLineReportConfig(pool, tenantId, { taxonomy: ['Claims'] });
    const res = await app.inject({
      method: 'POST', url: '/api/calls/retag',
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.retagged).toBe('number');
    expect(typeof body.remaining).toBe('number');
  });
});

// ── POST /api/calls/import-past ───────────────────────────────────────────

describe('POST /api/calls/import-past', () => {
  async function seedSentEmail(tenantId: string, subject: string, bodyText: string) {
    const sc = await createSmtpConfig(pool, KEY, {
      tenantId, name: 'local', host: '127.0.0.1', port: 2599, secure: false,
      username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
    });
    const s = await createSender(pool, { tenantId, email: 'a@x.com', displayName: 'A', smtpConfigId: sc.id });
    await pool.query(
      `INSERT INTO emails(tenant_id, sender_id, to_addr, subject, body_html, body_text, status)
       VALUES ($1,$2,'r@x.com',$3,'<p>x</p>',$4,'sent')`,
      [tenantId, s.id, subject, bodyText]);
  }

  it('returns 403 for non-admin', async () => {
    const { tenantId } = await adminSession();
    const { headers, csrf } = await nonAdminSession(tenantId);
    const res = await app.inject({
      method: 'POST', url: '/api/calls/import-past',
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken }, payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 200 with { imported, tagged } for admin', async () => {
    const { tenantId, headers, csrf } = await adminSession();
    await seedSentEmail(tenantId, 'Call', 'caller asking about their claim');
    await upsertLineReportConfig(pool, tenantId, { taxonomy: ['Claims'] });
    const res = await app.inject({
      method: 'POST', url: '/api/calls/import-past',
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken }, payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.imported).toBe('number');
    expect(typeof body.tagged).toBe('number');
    expect(body.imported).toBe(1);
  });
});

// ── POST /api/calls/setup-categories ──────────────────────────────────────

describe('POST /api/calls/setup-categories', () => {
  it('returns 403 for non-admin', async () => {
    const { tenantId } = await adminSession();
    const { headers, csrf } = await nonAdminSession(tenantId);
    const res = await app.inject({
      method: 'POST', url: '/api/calls/setup-categories',
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
      payload: { categories: ['Claims', 'Policy'] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 200 with { applied, categories, tagged } for admin', async () => {
    const { tenantId, headers, csrf } = await adminSession();
    // Seed a call so tagging has something to operate on.
    await seedInboundCall(pool, tenantId, 'Insurance claim for car accident');
    const res = await app.inject({
      method: 'POST', url: '/api/calls/setup-categories',
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
      payload: { categories: ['Claims', 'Policy'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.applied).toBe(true);
    expect(body.categories).toEqual(['Claims', 'Policy']);
    expect(typeof body.tagged).toBe('number');
  });
});

// ── GET/PUT /api/calls/settings ───────────────────────────────────────────

describe('GET/PUT /api/calls/settings', () => {
  it('GET returns ingestSendsAsCalls=false by default for admin', async () => {
    const { headers } = await adminSession();
    const res = await app.inject({ method: 'GET', url: '/api/calls/settings', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ingestSendsAsCalls: false });
  });

  it('PUT sets ingestSendsAsCalls=true and GET reflects it', async () => {
    const { headers, csrf } = await adminSession();
    const put = await app.inject({
      method: 'PUT', url: '/api/calls/settings',
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
      payload: { ingestSendsAsCalls: true },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ ingestSendsAsCalls: true });

    const get = await app.inject({ method: 'GET', url: '/api/calls/settings', headers });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ ingestSendsAsCalls: true });
  });

  it('GET returns 403 for non-admin', async () => {
    const { tenantId } = await adminSession();
    const { headers } = await nonAdminSession(tenantId);
    const res = await app.inject({ method: 'GET', url: '/api/calls/settings', headers });
    expect(res.statusCode).toBe(403);
  });

  it('PUT returns 403 for non-admin', async () => {
    const { tenantId } = await adminSession();
    const { headers, csrf } = await nonAdminSession(tenantId);
    const res = await app.inject({
      method: 'PUT', url: '/api/calls/settings',
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
      payload: { ingestSendsAsCalls: true },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ── NEW: GET /api/calls filters + sort + breakdown multi-dim ──────────────

// Helper: seed an inbound call with call_facts (attribution, outcome, etc.)
async function seedCallWithFacts(
  pool: pg.Pool,
  tenantId: string,
  opts: {
    content?: string;
    attribution?: string;
    outcome?: string;
    sentiment?: string;
    resolution?: string;
  } = {},
): Promise<{ id: string; thread_id: string }> {
  const call = await seedInboundCall(pool, tenantId, opts.content ?? 'test call');
  await pool.query(
    `INSERT INTO call_facts (message_id, tenant_id, attribution_label, call_outcome, sentiment, resolution_state)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [call.id, tenantId, opts.attribution ?? null, opts.outcome ?? null, opts.sentiment ?? null, opts.resolution ?? 'open'],
  );
  return call;
}

import type pg from 'pg';

describe('GET /api/calls — new filters', () => {
  it('filters by attribution_label', async () => {
    const { tenantId, headers } = await adminSession();
    await seedCallWithFacts(pool, tenantId, { content: 'Accounts call', attribution: 'Accounts' });
    await seedCallWithFacts(pool, tenantId, { content: 'Claims call', attribution: 'Claims' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/calls?attribution=Accounts&sort=attribution_label&sortDir=asc',
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.calls)).toBe(true);
    expect(body.calls).toHaveLength(1);
    expect(body.calls[0].attribution_label).toBe('Accounts');
  });

  it('rejects bogus sort field with 400', async () => {
    const { headers } = await adminSession();
    const res = await app.inject({
      method: 'GET',
      url: '/api/calls?sort=bogus',
      headers,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 for non-admin on GET /api/calls', async () => {
    const { tenantId } = await adminSession();
    const { headers } = await nonAdminSession(tenantId);
    const res = await app.inject({ method: 'GET', url: '/api/calls', headers });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /api/calls/breakdown — multi-dimension', () => {
  it('returns all dimension keys in response', async () => {
    const { tenantId, headers } = await adminSession();
    await seedCallWithFacts(pool, tenantId, { content: 'Test call', attribution: 'Accounts', outcome: 'resolved', sentiment: 'positive', resolution: 'resolved' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/calls/breakdown?window=7d',
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('summary');
    expect(body).toHaveProperty('byCategory');
    expect(body).toHaveProperty('byDepartment');
    expect(body).toHaveProperty('byOutcome');
    expect(body).toHaveProperty('bySentiment');
    expect(body).toHaveProperty('byResolution');
    expect(body).toHaveProperty('crosstab');
    expect(body).toHaveProperty('perDay');
    expect(Array.isArray(body.byCategory)).toBe(true);
    expect(Array.isArray(body.byDepartment)).toBe(true);
    expect(Array.isArray(body.byOutcome)).toBe(true);
    expect(Array.isArray(body.bySentiment)).toBe(true);
    expect(Array.isArray(body.byResolution)).toBe(true);
    expect(Array.isArray(body.crosstab)).toBe(true);
    expect(Array.isArray(body.perDay)).toBe(true);
    expect(typeof body.summary).toBe('object');
    expect(typeof body.summary.total).toBe('number');
  });
});

// ── GET /api/calls/:id ────────────────────────────────────────────────────

describe('GET /api/calls/:id', () => {
  it('returns the call by id', async () => {
    const { tenantId, headers } = await adminSession();
    const call = await seedInboundCall(pool, tenantId, 'A specific call');
    const res = await app.inject({ method: 'GET', url: `/api/calls/${call.id}`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().call.id).toBe(call.id);
  });

  it('returns 404 for unknown id', async () => {
    const { headers } = await adminSession();
    const res = await app.inject({
      method: 'GET',
      url: '/api/calls/00000000-0000-0000-0000-000000000000',
      headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it('does not leak another tenant\'s call (404)', async () => {
    const a = await adminSession();
    const tB = await createTenant(pool);
    const callB = await seedInboundCall(pool, tB.id, 'Tenant B secret call');
    const res = await app.inject({
      method: 'GET', url: `/api/calls/${callB.id}`, headers: a.headers,
    });
    expect(res.statusCode).toBe(404);
  });
});
