# Outbound Call Campaigns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tenant admin launch outbound Jobix calls in bulk via a call-campaign runner (pick a Jobix agent, enrol a list/segment or CSV of recipients, approve, and have a cron worker fire `customer/save` per recipient), with each launched call linked back to its inbound result.

**Architecture:** Three additive tables (`call_agents`, `call_campaigns`, `call_campaign_recipients`) mirroring the existing email-campaign pattern. Two new route modules (`callAgents`, `callCampaigns`), all `tenant_admin`/`super_admin` gated. A new cron `/v1/cron/process-call-queue` drains pending recipients through an injectable Jobix HTTP client. The outbound→inbound loop is closed by a single additive `linkResultBySuid` call inside the existing `/v1/jobix/calls` handler, matching on the `suid` we sent.

**Tech Stack:** Fastify + TypeScript (NodeNext ESM, `.js` import extensions), Postgres via `pg.Pool`, `node-pg-migrate` (`.cjs` migrations), Zod validation, Vitest (serial against the Neon test branch), React + Vite frontend with an `api<T>()` fetch helper.

**Reference spec:** `docs/superpowers/specs/2026-06-07-outbound-call-campaigns-design.md`

---

## Conventions (read once before starting)

- **Encryption:** `import { encrypt, decrypt } from '../crypto/enc.js'`. `encrypt(plaintext: string, key: Buffer): Buffer`, `decrypt(blob: Buffer, key: Buffer): string`. Key is `app.cfg.encKey` in routes, passed explicitly into repos/workers. Store ciphertext in a `bytea` column.
- **Auth:** `import { requireTenantCtx } from '../auth/ctx.js'`. Copy this local helper into each new route module:
  ```ts
  function requireAdmin(ctx: ReturnType<typeof requireTenantCtx>): void {
    if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') {
      throw new AppError('forbidden', 403, 'Admin role required');
    }
  }
  ```
- **Errors:** `import { AppError, sendError } from '../util/errors.js'`. `AppError(code, httpStatus, message, details?)`. Wrap every handler body in `try { ... } catch (e) { sendError(reply, e); }`. ZodError → 400 automatically.
- **Repos:** named exports; first arg `pool: pg.Pool`; parameterized `$1` queries; `jsonb` written via `JSON.stringify(...)`; tenant scoping always `WHERE tenant_id = $1`.
- **Tests — run command** (migrate the test branch first, then run serially):
  ```bash
  DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server run migrate
  TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism
  ```
- **Test helpers:** `makePool`, `truncateAll` from `./helpers/db.js`; `createTenant`, `createUser` from `./helpers/factories.js`; `csrfFor`, `login` from `./helpers/auth.js`. `truncateAll` clears all tables (including the new ones) between tests.
- **Frontend build check:** `npm -w web run build`.

---

## File Structure

**Create:**
- `server/migrations/1700000000031_call_campaigns.cjs` — the three tables
- `server/src/repos/callAgents.ts` — agent registry repo (encrypt/decrypt company_key)
- `server/src/repos/callCampaigns.ts` — campaigns + recipients + worker-helper queries
- `server/src/jobix/launchClient.ts` — `launchCall()` HTTP client for `customer/save`
- `server/src/calls/runCallQueue.ts` — worker orchestration (claim → launch → mark → complete)
- `server/src/routes/callAgents.ts` — agent CRUD routes
- `server/src/routes/callCampaigns.ts` — campaign routes
- `web/src/lib/callCampaigns.ts` — typed frontend client
- `web/src/pages/CallCampaigns.tsx` — campaigns + agents UI
- Test files alongside each (see tasks)

**Modify:**
- `server/src/routes/cron.ts` — add `/v1/cron/process-call-queue`
- `server/src/routes/v1Jobix.ts` — add the `linkResultBySuid` post-ingest hook
- `server/src/app.ts` — register the two new route modules
- `vercel.json` — add the cron schedule
- `web/src/routes.tsx` — add the route
- `web/src/components/AppShell.tsx` — add a nav link (follow the existing nav pattern)

---

## Task 1: Migration — the three tables

**Files:**
- Create: `server/migrations/1700000000031_call_campaigns.cjs`

> If B1's `call_actions` migration has already taken `031`, rename this to `1700000000032_call_campaigns.cjs` — no other change.

- [ ] **Step 1: Write the migration**

```js
/* eslint-disable camelcase */
exports.up = (pgm) => {
  // --- call_agents: per-tenant Jobix agent registry (encrypted company_key + values schema) ---
  pgm.createTable('call_agents', {
    id:                     { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:              { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    label:                  { type: 'text', notNull: true },
    company_key_encrypted:  { type: 'bytea', notNull: true },
    values_schema:          { type: 'jsonb', notNull: true, default: '[]' },
    default_timezone:       { type: 'text', notNull: true, default: 'Africa/Johannesburg' },
    active:                 { type: 'boolean', notNull: true, default: true },
    created_by:             { type: 'uuid', references: 'users(id)', onDelete: 'SET NULL' },
    created_at:             { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at:             { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('call_agents', 'call_agents_tenant_label_uniq', { unique: ['tenant_id', 'label'] });

  // --- call_campaigns: mirrors the email `campaigns` table ---
  pgm.createTable('call_campaigns', {
    id:              { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:       { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    agent_id:        { type: 'uuid', notNull: true, references: 'call_agents(id)', onDelete: 'RESTRICT' },
    name:            { type: 'text', notNull: true },
    audience_type:   { type: 'text', notNull: true, check: "audience_type IN ('list','segment','csv')" },
    audience_id:     { type: 'uuid' },
    scheduled_for:   { type: 'timestamptz' },
    status:          { type: 'text', notNull: true, default: 'draft',
                       check: "status IN ('draft','approved','running','paused','completed','canceled')" },
    recipient_count: { type: 'integer', notNull: true, default: 0 },
    approved_by:     { type: 'uuid', references: 'users(id)', onDelete: 'SET NULL' },
    approved_at:     { type: 'timestamptz' },
    created_by:      { type: 'uuid', references: 'users(id)', onDelete: 'SET NULL' },
    created_at:      { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at:      { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('call_campaigns', ['tenant_id', 'status']);
  pgm.createIndex('call_campaigns', ['agent_id']);

  // --- call_campaign_recipients: per-recipient, mirrors `emails` rows ---
  pgm.createTable('call_campaign_recipients', {
    id:                 { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:          { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    campaign_id:        { type: 'uuid', notNull: true, references: 'call_campaigns(id)', onDelete: 'CASCADE' },
    suid:               { type: 'text', notNull: true },
    name:               { type: 'text', notNull: true },
    phone:              { type: 'text', notNull: true },
    timezone:           { type: 'text' },
    values:             { type: 'jsonb', notNull: true, default: '{}' },
    contact_id:         { type: 'uuid', references: 'contacts(id)', onDelete: 'SET NULL' },
    status:             { type: 'text', notNull: true, default: 'pending',
                          check: "status IN ('pending','queued','launched','failed','suppressed','completed','canceled')" },
    attempts:           { type: 'integer', notNull: true, default: 0 },
    last_error:         { type: 'text' },
    jobix_response:     { type: 'jsonb' },
    launched_at:        { type: 'timestamptz' },
    result_message_id:  { type: 'uuid', references: 'agent_messages(id)', onDelete: 'SET NULL' },
    outcome:            { type: 'text' },
    created_at:         { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at:         { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('call_campaign_recipients', 'call_recipients_tenant_suid_uniq', { unique: ['tenant_id', 'suid'] });
  pgm.createIndex('call_campaign_recipients', ['campaign_id', 'status']);
  pgm.createIndex('call_campaign_recipients', ['result_message_id']);
};

exports.down = (pgm) => {
  pgm.dropTable('call_campaign_recipients');
  pgm.dropTable('call_campaigns');
  pgm.dropTable('call_agents');
};
```

- [ ] **Step 2: Apply to the test branch**

Run: `DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server run migrate`
Expected: migration `1700000000031_call_campaigns` runs, "Migrations complete".

- [ ] **Step 3: Commit**

```bash
git add server/migrations/1700000000031_call_campaigns.cjs
git commit -m "feat(calls): migration for outbound call campaigns (agents, campaigns, recipients)"
```

---

## Task 2: callAgents repo

**Files:**
- Create: `server/src/repos/callAgents.ts`
- Test: `server/test/callAgents.repo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createAgent, listAgents, getAgentForLaunch, updateAgent } from '../src/repos/callAgents.js';

const KEY = Buffer.alloc(32, 7);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('callAgents repo', () => {
  it('encrypts company_key on create and never returns it from listAgents', async () => {
    const t = await createTenant(pool);
    const agent = await createAgent(pool, KEY, {
      tenantId: t.id, label: 'Arrears', companyKey: 'V7E-secret-key',
      valuesSchema: [{ key: 'unit_number', label: 'Unit', required: true }],
    });
    expect(agent).not.toHaveProperty('company_key_encrypted');
    expect(agent).not.toHaveProperty('companyKey');

    const list = await listAgents(pool, t.id);
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('Arrears');
    expect(list[0]).not.toHaveProperty('companyKey');
    expect(JSON.stringify(list[0])).not.toContain('V7E-secret-key');
  });

  it('getAgentForLaunch decrypts the key (server-only)', async () => {
    const t = await createTenant(pool);
    const agent = await createAgent(pool, KEY, { tenantId: t.id, label: 'A', companyKey: 'sk-123', valuesSchema: [] });
    const launch = await getAgentForLaunch(pool, KEY, t.id, agent.id);
    expect(launch?.companyKey).toBe('sk-123');
    expect(launch?.defaultTimezone).toBe('Africa/Johannesburg');
  });

  it('updateAgent can rotate the key and toggle active', async () => {
    const t = await createTenant(pool);
    const agent = await createAgent(pool, KEY, { tenantId: t.id, label: 'A', companyKey: 'old', valuesSchema: [] });
    await updateAgent(pool, KEY, t.id, agent.id, { companyKey: 'new', active: false });
    const launch = await getAgentForLaunch(pool, KEY, t.id, agent.id);
    expect(launch?.companyKey).toBe('new');
    expect(launch?.active).toBe(false);
  });

  it('cross-tenant getAgentForLaunch returns null', async () => {
    const t1 = await createTenant(pool); const t2 = await createTenant(pool);
    const agent = await createAgent(pool, KEY, { tenantId: t1.id, label: 'A', companyKey: 'k', valuesSchema: [] });
    expect(await getAgentForLaunch(pool, KEY, t2.id, agent.id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism callAgents.repo`
Expected: FAIL — cannot find module `../src/repos/callAgents.js`.

- [ ] **Step 3: Implement the repo**

```ts
import type pg from 'pg';
import { encrypt, decrypt } from '../crypto/enc.js';

export interface ValuesField { key: string; label: string; required: boolean; type?: string }

export interface AgentPublic {
  id: string; tenant_id: string; label: string; values_schema: ValuesField[];
  default_timezone: string; active: boolean; hasKey: true;
  created_at: Date; updated_at: Date;
}

export interface AgentForLaunch {
  id: string; tenantId: string; label: string; companyKey: string;
  valuesSchema: ValuesField[]; defaultTimezone: string; active: boolean;
}

interface CreateInput {
  tenantId: string; label: string; companyKey: string;
  valuesSchema: ValuesField[]; defaultTimezone?: string; createdBy?: string;
}

function toPublic(row: Record<string, unknown>): AgentPublic {
  return {
    id: row.id as string, tenant_id: row.tenant_id as string, label: row.label as string,
    values_schema: (row.values_schema as ValuesField[]) ?? [],
    default_timezone: row.default_timezone as string, active: row.active as boolean,
    hasKey: true, created_at: row.created_at as Date, updated_at: row.updated_at as Date,
  };
}

export async function createAgent(pool: pg.Pool, key: Buffer, input: CreateInput): Promise<AgentPublic> {
  const enc = encrypt(input.companyKey, key);
  const r = await pool.query(
    `INSERT INTO call_agents (tenant_id, label, company_key_encrypted, values_schema, default_timezone, created_by)
     VALUES ($1,$2,$3,$4,COALESCE($5,'Africa/Johannesburg'),$6)
     RETURNING id, tenant_id, label, values_schema, default_timezone, active, created_at, updated_at`,
    [input.tenantId, input.label, enc, JSON.stringify(input.valuesSchema ?? []),
     input.defaultTimezone ?? null, input.createdBy ?? null]);
  return toPublic(r.rows[0]);
}

export async function listAgents(pool: pg.Pool, tenantId: string): Promise<AgentPublic[]> {
  const r = await pool.query(
    `SELECT id, tenant_id, label, values_schema, default_timezone, active, created_at, updated_at
     FROM call_agents WHERE tenant_id = $1 ORDER BY label`, [tenantId]);
  return r.rows.map(toPublic);
}

export async function getAgentForLaunch(pool: pg.Pool, key: Buffer, tenantId: string, agentId: string): Promise<AgentForLaunch | null> {
  const r = await pool.query<{ id: string; tenant_id: string; label: string; company_key_encrypted: Buffer;
    values_schema: ValuesField[]; default_timezone: string; active: boolean }>(
    `SELECT id, tenant_id, label, company_key_encrypted, values_schema, default_timezone, active
     FROM call_agents WHERE tenant_id = $1 AND id = $2`, [tenantId, agentId]);
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id, tenantId: row.tenant_id, label: row.label,
    companyKey: decrypt(row.company_key_encrypted, key),
    valuesSchema: row.values_schema ?? [], defaultTimezone: row.default_timezone, active: row.active,
  };
}

interface UpdateInput { label?: string; valuesSchema?: ValuesField[]; defaultTimezone?: string; active?: boolean; companyKey?: string }

export async function updateAgent(pool: pg.Pool, key: Buffer, tenantId: string, agentId: string, patch: UpdateInput): Promise<AgentPublic | null> {
  const sets: string[] = []; const params: unknown[] = [];
  const set = (frag: string, val: unknown) => { params.push(val); sets.push(`${frag} = $${params.length}`); };
  if (patch.label !== undefined) set('label', patch.label);
  if (patch.valuesSchema !== undefined) set('values_schema', JSON.stringify(patch.valuesSchema));
  if (patch.defaultTimezone !== undefined) set('default_timezone', patch.defaultTimezone);
  if (patch.active !== undefined) set('active', patch.active);
  if (patch.companyKey !== undefined) set('company_key_encrypted', encrypt(patch.companyKey, key));
  if (sets.length === 0) { const l = await listAgents(pool, tenantId); return l.find(a => a.id === agentId) ?? null; }
  params.push(tenantId, agentId);
  const r = await pool.query(
    `UPDATE call_agents SET ${sets.join(', ')}, updated_at = now()
     WHERE tenant_id = $${params.length - 1} AND id = $${params.length}
     RETURNING id, tenant_id, label, values_schema, default_timezone, active, created_at, updated_at`, params);
  return r.rows[0] ? toPublic(r.rows[0]) : null;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism callAgents.repo`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/repos/callAgents.ts server/test/callAgents.repo.test.ts
git commit -m "feat(calls): callAgents repo with encrypted company_key"
```

---

## Task 3: callCampaigns repo — campaigns CRUD + transitions

**Files:**
- Create: `server/src/repos/callCampaigns.ts`
- Test: `server/test/callCampaigns.repo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createAgent } from '../src/repos/callAgents.js';
import { createCampaign, getCampaign, listCampaigns, approveCampaign, cancelCampaign } from '../src/repos/callCampaigns.js';

const KEY = Buffer.alloc(32, 7);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function agentFor(tenantId: string) {
  return createAgent(pool, KEY, { tenantId, label: 'A', companyKey: 'k', valuesSchema: [] });
}

describe('callCampaigns repo — campaigns', () => {
  it('creates a draft campaign', async () => {
    const t = await createTenant(pool); const a = await agentFor(t.id);
    const c = await createCampaign(pool, { tenantId: t.id, agentId: a.id, name: 'Q3 arrears', audienceType: 'csv' });
    expect(c.status).toBe('draft');
    const got = await getCampaign(pool, t.id, c.id);
    expect(got?.name).toBe('Q3 arrears');
    expect(got?.counts).toEqual({ pending: 0, queued: 0, launched: 0, failed: 0, suppressed: 0, completed: 0, canceled: 0 });
  });

  it('approveCampaign rejects a campaign with zero recipients', async () => {
    const t = await createTenant(pool); const a = await agentFor(t.id);
    const c = await createCampaign(pool, { tenantId: t.id, agentId: a.id, name: 'Empty', audienceType: 'csv' });
    await expect(approveCampaign(pool, t.id, c.id, null)).rejects.toThrow();
    const got = await getCampaign(pool, t.id, c.id);
    expect(got?.status).toBe('draft');
  });

  it('cancelCampaign moves draft to canceled', async () => {
    const t = await createTenant(pool); const a = await agentFor(t.id);
    const c = await createCampaign(pool, { tenantId: t.id, agentId: a.id, name: 'X', audienceType: 'csv' });
    await cancelCampaign(pool, t.id, c.id);
    expect((await getCampaign(pool, t.id, c.id))?.status).toBe('canceled');
  });

  it('listCampaigns is tenant-scoped', async () => {
    const t1 = await createTenant(pool); const t2 = await createTenant(pool);
    const a = await agentFor(t1.id);
    await createCampaign(pool, { tenantId: t1.id, agentId: a.id, name: 'mine', audienceType: 'csv' });
    expect(await listCampaigns(pool, t2.id)).toHaveLength(0);
    expect(await listCampaigns(pool, t1.id)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism callCampaigns.repo`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the campaigns half of the repo**

```ts
import type pg from 'pg';
import { AppError } from '../util/errors.js';

export type CampaignStatus = 'draft' | 'approved' | 'running' | 'paused' | 'completed' | 'canceled';
export type RecipientStatus = 'pending' | 'queued' | 'launched' | 'failed' | 'suppressed' | 'completed' | 'canceled';

export interface CampaignRow {
  id: string; tenant_id: string; agent_id: string; name: string;
  audience_type: 'list' | 'segment' | 'csv'; audience_id: string | null;
  scheduled_for: Date | null; status: CampaignStatus; recipient_count: number;
  approved_by: string | null; approved_at: Date | null; created_by: string | null;
  created_at: Date; updated_at: Date;
}

export type CampaignCounts = Record<RecipientStatus, number>;
export interface CampaignWithCounts extends CampaignRow { counts: CampaignCounts }

const EMPTY_COUNTS: CampaignCounts = { pending: 0, queued: 0, launched: 0, failed: 0, suppressed: 0, completed: 0, canceled: 0 };

interface CreateCampaignInput {
  tenantId: string; agentId: string; name: string;
  audienceType: 'list' | 'segment' | 'csv'; audienceId?: string | null;
  scheduledFor?: Date | null; createdBy?: string | null;
}

export async function createCampaign(pool: pg.Pool, input: CreateCampaignInput): Promise<CampaignRow> {
  const agent = await pool.query(`SELECT id, active FROM call_agents WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.agentId]);
  if (!agent.rows[0]) throw new AppError('not_found', 404, 'Agent not found');
  if (!agent.rows[0].active) throw new AppError('agent_inactive', 400, 'Agent is not active');
  const r = await pool.query<CampaignRow>(
    `INSERT INTO call_campaigns (tenant_id, agent_id, name, audience_type, audience_id, scheduled_for, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [input.tenantId, input.agentId, input.name, input.audienceType,
     input.audienceId ?? null, input.scheduledFor ?? null, input.createdBy ?? null]);
  return r.rows[0];
}

async function countsFor(pool: pg.Pool, campaignId: string): Promise<CampaignCounts> {
  const r = await pool.query<{ status: RecipientStatus; n: string }>(
    `SELECT status, COUNT(*)::text AS n FROM call_campaign_recipients WHERE campaign_id = $1 GROUP BY status`,
    [campaignId]);
  const counts: CampaignCounts = { ...EMPTY_COUNTS };
  for (const row of r.rows) counts[row.status] = Number(row.n);
  return counts;
}

export async function getCampaign(pool: pg.Pool, tenantId: string, id: string): Promise<CampaignWithCounts | null> {
  const r = await pool.query<CampaignRow>(`SELECT * FROM call_campaigns WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  const row = r.rows[0];
  if (!row) return null;
  return { ...row, counts: await countsFor(pool, id) };
}

export async function listCampaigns(pool: pg.Pool, tenantId: string): Promise<CampaignWithCounts[]> {
  const r = await pool.query<CampaignRow>(`SELECT * FROM call_campaigns WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  const out: CampaignWithCounts[] = [];
  for (const row of r.rows) out.push({ ...row, counts: await countsFor(pool, row.id) });
  return out;
}

async function transition(pool: pg.Pool, tenantId: string, id: string, from: CampaignStatus[], to: CampaignStatus, extra = ''): Promise<CampaignRow> {
  const r = await pool.query<CampaignRow>(
    `UPDATE call_campaigns SET status = $3${extra}, updated_at = now()
     WHERE tenant_id = $1 AND id = $2 AND status = ANY($4) RETURNING *`,
    [tenantId, id, to, from]);
  if (!r.rows[0]) {
    const exists = await pool.query(`SELECT status FROM call_campaigns WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
    if (!exists.rows[0]) throw new AppError('not_found', 404, 'Campaign not found');
    throw new AppError('invalid_transition', 400, `Cannot move campaign from ${exists.rows[0].status} to ${to}`);
  }
  return r.rows[0];
}

export async function approveCampaign(pool: pg.Pool, tenantId: string, id: string, userId: string | null): Promise<CampaignRow> {
  const valid = await validateRecipients(pool, tenantId, id);
  if (!valid.ok) throw new AppError('validation_failed', 400, 'Campaign has invalid recipients', valid.errors);
  const count = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM call_campaign_recipients WHERE campaign_id = $1 AND status = 'pending'`, [id]);
  if (Number(count.rows[0].n) === 0) throw new AppError('no_recipients', 400, 'Campaign has no recipients to launch');
  return transition(pool, tenantId, id, ['draft'], 'approved',
    `, approved_by = ${userId ? `'${userId}'::uuid` : 'NULL'}, approved_at = now()`);
}

export async function pauseCampaign(pool: pg.Pool, tenantId: string, id: string): Promise<CampaignRow> {
  return transition(pool, tenantId, id, ['approved', 'running'], 'paused');
}

export async function resumeCampaign(pool: pg.Pool, tenantId: string, id: string): Promise<CampaignRow> {
  return transition(pool, tenantId, id, ['paused'], 'approved');
}

export async function cancelCampaign(pool: pg.Pool, tenantId: string, id: string): Promise<CampaignRow> {
  return transition(pool, tenantId, id, ['draft', 'approved', 'running', 'paused'], 'canceled');
}
```

> Note: `validateRecipients` is added in Task 4. Until then this file won't compile — that's expected; Task 4 completes it. (If running Task 3's test in isolation first, temporarily stub `export async function validateRecipients() { return { ok: true, errors: [] as string[] }; }` and replace it in Task 4. The plan executor should do Tasks 3 and 4 back-to-back and commit once at the end of Task 4 if preferred.)

- [ ] **Step 4: Add the temporary stub so the test compiles**

Append to `callCampaigns.ts` (removed in Task 4):
```ts
export async function validateRecipients(_pool: pg.Pool, _tenantId: string, _id: string): Promise<{ ok: boolean; errors: string[] }> {
  return { ok: true, errors: [] };
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism callCampaigns.repo`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/repos/callCampaigns.ts server/test/callCampaigns.repo.test.ts
git commit -m "feat(calls): callCampaigns repo — campaign CRUD and transitions"
```

---

## Task 4: callCampaigns repo — recipients (audience, CSV, validation)

**Files:**
- Modify: `server/src/repos/callCampaigns.ts`
- Test: `server/test/callCampaignsRecipients.repo.test.ts`

Resolution rules (from the spec): `name` ← contact `name` column; `phone` ← `attributes.phone`; each agent values `key` ← `attributes[key]`. Missing `phone` or any **required** values key is a validation error.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createAgent } from '../src/repos/callAgents.js';
import { createCampaign, getCampaign, validateRecipients,
  addRecipientsFromCsv, addRecipientsFromAudience, listRecipients } from '../src/repos/callCampaigns.js';

const KEY = Buffer.alloc(32, 7);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

const schema = [{ key: 'unit_number', label: 'Unit', required: true }, { key: 'arrears_amount', label: 'Arrears', required: false }];

async function setup() {
  const t = await createTenant(pool);
  const a = await createAgent(pool, KEY, { tenantId: t.id, label: 'Arrears', companyKey: 'k', valuesSchema: schema });
  const c = await createCampaign(pool, { tenantId: t.id, agentId: a.id, name: 'C', audienceType: 'csv' });
  return { t, a, c };
}

describe('callCampaigns repo — recipients', () => {
  it('addRecipientsFromCsv maps name/phone/values and bumps recipient_count', async () => {
    const { t, c } = await setup();
    const res = await addRecipientsFromCsv(pool, { tenantId: t.id, campaignId: c.id, agentId: c.agent_id,
      rows: [{ name: 'Renier', phone: '+27609381283', unit_number: '103', arrears_amount: '2449.46' }] });
    expect(res.added).toBe(1);
    expect(res.errors).toHaveLength(0);
    const recips = await listRecipients(pool, t.id, c.id, {});
    expect(recips.recipients[0].name).toBe('Renier');
    expect(recips.recipients[0].values).toEqual({ unit_number: '103', arrears_amount: '2449.46' });
    expect((await getCampaign(pool, t.id, c.id))?.recipient_count).toBe(1);
  });

  it('addRecipientsFromCsv flags a row missing a required value', async () => {
    const { t, c } = await setup();
    const res = await addRecipientsFromCsv(pool, { tenantId: t.id, campaignId: c.id, agentId: c.agent_id,
      rows: [{ name: 'NoUnit', phone: '+2760', arrears_amount: '10' }] });
    expect(res.added).toBe(0);
    expect(res.errors.length).toBeGreaterThan(0);
  });

  it('addRecipientsFromAudience pulls phone + values from contact attributes', async () => {
    const { t, a } = await setup();
    // seed a contact + list
    const contact = await pool.query(
      `INSERT INTO contacts (tenant_id, email, name, attributes) VALUES ($1,$2,$3,$4) RETURNING id`,
      [t.id, 'r@x.io', 'Renier', JSON.stringify({ phone: '+27609381283', unit_number: '103' })]);
    const list = await pool.query(`INSERT INTO contact_lists (tenant_id, name) VALUES ($1,'L') RETURNING id`, [t.id]);
    await pool.query(`INSERT INTO contact_list_members (list_id, contact_id) VALUES ($1,$2)`, [list.rows[0].id, contact.rows[0].id]);
    const c2 = await createCampaign(pool, { tenantId: t.id, agentId: a.id, name: 'L', audienceType: 'list', audienceId: list.rows[0].id });
    const res = await addRecipientsFromAudience(pool, { tenantId: t.id, campaignId: c2.id, agentId: a.id, audienceType: 'list', audienceId: list.rows[0].id });
    expect(res.added).toBe(1);
    const recips = await listRecipients(pool, t.id, c2.id, {});
    expect(recips.recipients[0].phone).toBe('+27609381283');
    expect(recips.recipients[0].values).toEqual({ unit_number: '103' });
    expect(recips.recipients[0].contact_id).toBe(contact.rows[0].id);
  });

  it('validateRecipients returns ok=false when a required value is missing', async () => {
    const { t, c } = await setup();
    // insert a recipient directly missing the required unit_number
    await pool.query(
      `INSERT INTO call_campaign_recipients (tenant_id, campaign_id, suid, name, phone, values)
       VALUES ($1,$2,$3,'X','+2760','{}')`, [t.id, c.id, 'suid-1']);
    const v = await validateRecipients(pool, t.id, c.id);
    expect(v.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism callCampaignsRecipients.repo`
Expected: FAIL — `addRecipientsFromCsv` / `addRecipientsFromAudience` / `listRecipients` not exported.

- [ ] **Step 3: Implement recipients in `callCampaigns.ts`**

First, **delete** the temporary `validateRecipients` stub from Task 3. Then add these imports at the top and the functions below:

```ts
import { randomUUID } from 'node:crypto';
import type { ValuesField } from './callAgents.js';
import { listMembers } from './contactLists.js';
import { listSegmentContactIds } from './segments.js';
import { getContactsByIds } from './contacts.js';

export interface RecipientRow {
  id: string; tenant_id: string; campaign_id: string; suid: string; name: string; phone: string;
  timezone: string | null; values: Record<string, unknown>; contact_id: string | null;
  status: RecipientStatus; attempts: number; last_error: string | null;
  jobix_response: unknown; launched_at: Date | null; result_message_id: string | null;
  outcome: string | null; created_at: Date; updated_at: Date;
}

interface ResolvedRecipient { name: string; phone: string; values: Record<string, unknown>; contactId?: string | null; error?: string }

async function agentSchema(pool: pg.Pool, tenantId: string, agentId: string): Promise<ValuesField[]> {
  const r = await pool.query<{ values_schema: ValuesField[] }>(
    `SELECT values_schema FROM call_agents WHERE tenant_id = $1 AND id = $2`, [tenantId, agentId]);
  return r.rows[0]?.values_schema ?? [];
}

function resolveValues(schema: ValuesField[], src: Record<string, unknown>): { values: Record<string, unknown>; missing: string[] } {
  const values: Record<string, unknown> = {}; const missing: string[] = [];
  for (const f of schema) {
    const v = src[f.key];
    if (v === undefined || v === null || v === '') { if (f.required) missing.push(f.key); continue; }
    values[f.key] = v;
  }
  return { values, missing };
}

async function insertRecipients(pool: pg.Pool, tenantId: string, campaignId: string, resolved: ResolvedRecipient[]): Promise<{ added: number; errors: string[] }> {
  const errors: string[] = []; let added = 0;
  for (let i = 0; i < resolved.length; i++) {
    const r = resolved[i];
    if (r.error) { errors.push(`Row ${i + 1}: ${r.error}`); continue; }
    await pool.query(
      `INSERT INTO call_campaign_recipients (tenant_id, campaign_id, suid, name, phone, values, contact_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id, suid) DO NOTHING`,
      [tenantId, campaignId, randomUUID(), r.name, r.phone, JSON.stringify(r.values), r.contactId ?? null]);
    added++;
  }
  await pool.query(
    `UPDATE call_campaigns SET recipient_count = (SELECT COUNT(*) FROM call_campaign_recipients WHERE campaign_id = $1), updated_at = now()
     WHERE id = $1`, [campaignId]);
  return { added, errors };
}

export async function addRecipientsFromCsv(pool: pg.Pool, args: { tenantId: string; campaignId: string; agentId: string; rows: Record<string, string>[] }): Promise<{ added: number; errors: string[] }> {
  const schema = await agentSchema(pool, args.tenantId, args.agentId);
  const resolved: ResolvedRecipient[] = args.rows.map(row => {
    const name = (row.name ?? '').trim(); const phone = (row.phone ?? '').trim();
    if (!name || !phone) return { name, phone, values: {}, error: 'missing name or phone' };
    const { values, missing } = resolveValues(schema, row);
    if (missing.length) return { name, phone, values, error: `missing required values: ${missing.join(', ')}` };
    return { name, phone, values };
  });
  return insertRecipients(pool, args.tenantId, args.campaignId, resolved);
}

export async function addRecipientsFromAudience(pool: pg.Pool, args: { tenantId: string; campaignId: string; agentId: string; audienceType: 'list' | 'segment'; audienceId: string }): Promise<{ added: number; errors: string[] }> {
  const schema = await agentSchema(pool, args.tenantId, args.agentId);
  let contacts;
  if (args.audienceType === 'list') {
    contacts = await listMembers(pool, args.tenantId, args.audienceId);
  } else {
    const seg = await pool.query<{ filter: { op: 'and' | 'or'; rules: unknown[] } }>(
      `SELECT filter FROM segments WHERE tenant_id = $1 AND id = $2`, [args.tenantId, args.audienceId]);
    if (!seg.rows[0]) throw new AppError('not_found', 404, 'Segment not found');
    const ids = await listSegmentContactIds(pool, args.tenantId, seg.rows[0].filter as never);
    contacts = await getContactsByIds(pool, args.tenantId, ids, false);
  }
  const resolved: ResolvedRecipient[] = contacts.map(ct => {
    const attrs = (ct.attributes ?? {}) as Record<string, unknown>;
    const name = (ct.name ?? '').toString().trim();
    const phone = (attrs.phone ?? '').toString().trim();
    if (!name || !phone) return { name, phone, values: {}, contactId: ct.id, error: 'contact missing name or phone attribute' };
    const { values, missing } = resolveValues(schema, attrs);
    if (missing.length) return { name, phone, values, contactId: ct.id, error: `missing required values: ${missing.join(', ')}` };
    return { name, phone, values, contactId: ct.id };
  });
  return insertRecipients(pool, args.tenantId, args.campaignId, resolved);
}

export async function listRecipients(pool: pg.Pool, tenantId: string, campaignId: string, opts: { status?: RecipientStatus; limit?: number; offset?: number }): Promise<{ recipients: RecipientRow[]; total: number }> {
  const params: unknown[] = [tenantId, campaignId];
  let where = `tenant_id = $1 AND campaign_id = $2`;
  if (opts.status) { params.push(opts.status); where += ` AND status = $${params.length}`; }
  const total = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM call_campaign_recipients WHERE ${where}`, params);
  params.push(opts.limit ?? 100, opts.offset ?? 0);
  const r = await pool.query<RecipientRow>(
    `SELECT * FROM call_campaign_recipients WHERE ${where} ORDER BY created_at LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { recipients: r.rows, total: Number(total.rows[0].n) };
}

export async function validateRecipients(pool: pg.Pool, tenantId: string, campaignId: string): Promise<{ ok: boolean; errors: string[] }> {
  const camp = await pool.query<{ agent_id: string }>(`SELECT agent_id FROM call_campaigns WHERE tenant_id = $1 AND id = $2`, [tenantId, campaignId]);
  if (!camp.rows[0]) throw new AppError('not_found', 404, 'Campaign not found');
  const schema = await agentSchema(pool, tenantId, camp.rows[0].agent_id);
  const required = schema.filter(f => f.required).map(f => f.key);
  const recips = await pool.query<{ id: string; phone: string; values: Record<string, unknown> }>(
    `SELECT id, phone, values FROM call_campaign_recipients WHERE campaign_id = $1 AND status NOT IN ('canceled')`, [campaignId]);
  const errors: string[] = [];
  for (const r of recips.rows) {
    if (!r.phone) errors.push(`Recipient ${r.id}: missing phone`);
    for (const key of required) {
      const v = (r.values ?? {})[key];
      if (v === undefined || v === null || v === '') errors.push(`Recipient ${r.id}: missing required value ${key}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
```

> If `getContactsByIds`'s exact signature differs, adapt the call — it resolves an id array to `ContactRow[]` (`getContactsByIds(pool, tenantId, ids, subscribedOnly)`).

- [ ] **Step 4: Run the test to confirm it passes**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism callCampaignsRecipients.repo`
Expected: PASS (4 tests). Re-run Task 3's test too — still PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/repos/callCampaigns.ts server/test/callCampaignsRecipients.repo.test.ts
git commit -m "feat(calls): callCampaigns recipients — audience/CSV resolution + validation"
```

---

## Task 5: callCampaigns repo — worker helpers

**Files:**
- Modify: `server/src/repos/callCampaigns.ts`
- Test: `server/test/callCampaignsWorker.repo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createAgent } from '../src/repos/callAgents.js';
import { createCampaign, addRecipientsFromCsv, approveCampaign, getCampaign } from '../src/repos/callCampaigns.js';
import { claimPending, markLaunched, markFailed, completeFinishedCampaigns, linkResultBySuid } from '../src/repos/callCampaigns.js';

const KEY = Buffer.alloc(32, 7);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function approvedCampaign(n: number) {
  const t = await createTenant(pool);
  const a = await createAgent(pool, KEY, { tenantId: t.id, label: 'A', companyKey: 'k', valuesSchema: [] });
  const c = await createCampaign(pool, { tenantId: t.id, agentId: a.id, name: 'C', audienceType: 'csv' });
  const rows = Array.from({ length: n }, (_, i) => ({ name: `n${i}`, phone: `+2760000000${i}` }));
  await addRecipientsFromCsv(pool, { tenantId: t.id, campaignId: c.id, agentId: a.id, rows });
  await approveCampaign(pool, t.id, c.id, null);
  return { t, c };
}

describe('callCampaigns repo — worker helpers', () => {
  it('claimPending claims approved-campaign recipients and flips them to queued', async () => {
    const { c } = await approvedCampaign(3);
    const claimed = await claimPending(pool, 2, 3);
    expect(claimed).toHaveLength(2);
    expect(claimed.every(r => r.status === 'queued')).toBe(true);
    expect(claimed[0].campaign_id).toBe(c.id);
  });

  it('markLaunched sets launched + launched_at; markFailed increments attempts', async () => {
    const { c } = await approvedCampaign(1);
    const [r] = await claimPending(pool, 10, 3);
    await markLaunched(pool, r.id, { status: 'accepted' });
    await markFailed(pool, r.id, 'boom'); // independent row scenario below
    const fresh = await getCampaign(pool, r.tenant_id, c.id);
    expect(fresh).toBeTruthy();
  });

  it('completeFinishedCampaigns marks a campaign completed when nothing is left to do', async () => {
    const { t, c } = await approvedCampaign(1);
    const [r] = await claimPending(pool, 10, 3);
    await markLaunched(pool, r.id, {});
    // simulate the inbound result arriving
    await pool.query(`UPDATE call_campaign_recipients SET status = 'completed' WHERE id = $1`, [r.id]);
    await completeFinishedCampaigns(pool, 3);
    expect((await getCampaign(pool, t.id, c.id))?.status).toBe('completed');
  });

  it('linkResultBySuid returns false when no recipient matches', async () => {
    const t = await createTenant(pool);
    expect(await linkResultBySuid(pool, t.id, 'no-such-suid', null, 'completed')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism callCampaignsWorker.repo`
Expected: FAIL — worker helpers not exported.

- [ ] **Step 3: Implement the worker helpers in `callCampaigns.ts`**

```ts
export async function claimPending(pool: pg.Pool, batchSize: number, maxAttempts: number): Promise<RecipientRow[]> {
  const r = await pool.query<RecipientRow>(
    `UPDATE call_campaign_recipients SET status = 'queued', updated_at = now()
     WHERE id IN (
       SELECT r.id FROM call_campaign_recipients r
       JOIN call_campaigns c ON c.id = r.campaign_id
       WHERE c.status IN ('approved','running')
         AND (c.scheduled_for IS NULL OR c.scheduled_for <= now())
         AND (r.status = 'pending' OR (r.status = 'failed' AND r.attempts < $1))
       ORDER BY r.created_at
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`, [maxAttempts, batchSize]);
  if (r.rows.length) {
    const campaignIds = [...new Set(r.rows.map(x => x.campaign_id))];
    await pool.query(`UPDATE call_campaigns SET status = 'running', updated_at = now()
                      WHERE id = ANY($1) AND status = 'approved'`, [campaignIds]);
  }
  return r.rows;
}

export async function markLaunched(pool: pg.Pool, recipientId: string, response: unknown): Promise<void> {
  await pool.query(
    `UPDATE call_campaign_recipients
     SET status = 'launched', launched_at = now(), attempts = attempts + 1,
         jobix_response = $2, last_error = NULL, updated_at = now()
     WHERE id = $1`, [recipientId, JSON.stringify(response ?? null)]);
}

export async function markFailed(pool: pg.Pool, recipientId: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE call_campaign_recipients
     SET status = 'failed', attempts = attempts + 1, last_error = $2, updated_at = now()
     WHERE id = $1`, [recipientId, error.slice(0, 2000)]);
}

export async function completeFinishedCampaigns(pool: pg.Pool, maxAttempts: number): Promise<number> {
  const r = await pool.query(
    `UPDATE call_campaigns c SET status = 'completed', updated_at = now()
     WHERE c.status = 'running'
       AND NOT EXISTS (
         SELECT 1 FROM call_campaign_recipients r
         WHERE r.campaign_id = c.id
           AND (r.status IN ('pending','queued') OR (r.status = 'failed' AND r.attempts < $1))
       )`, [maxAttempts]);
  return r.rowCount ?? 0;
}

export async function linkResultBySuid(pool: pg.Pool, tenantId: string, suid: string, messageId: string | null, outcome: string | null): Promise<boolean> {
  const r = await pool.query(
    `UPDATE call_campaign_recipients
     SET result_message_id = $3, outcome = $4, status = 'completed', updated_at = now()
     WHERE tenant_id = $1 AND suid = $2`, [tenantId, suid, messageId, outcome]);
  return (r.rowCount ?? 0) > 0;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism callCampaignsWorker.repo`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/repos/callCampaigns.ts server/test/callCampaignsWorker.repo.test.ts
git commit -m "feat(calls): callCampaigns worker helpers — claim/mark/complete/link"
```

---

## Task 6: Jobix launch client

**Files:**
- Create: `server/src/jobix/launchClient.ts`
- Test: `server/test/jobixLaunchClient.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { launchCall } from '../src/jobix/launchClient.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('launchCall', () => {
  it('POSTs the customer/save payload and returns ok on 2xx', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'accepted' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await launchCall({ companyKey: 'ck', suid: 's1', name: 'R', phone: '+2760', timezone: 'Africa/Johannesburg', values: { unit_number: '103' } });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://dashboard-api.jobix.ai/v1/customer/save');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      company_key: 'ck',
      customer_data: { main: { suid: 's1', name: 'R', phone: '+2760', timezone: 'Africa/Johannesburg' }, values: { unit_number: '103' } },
    });
  });

  it('returns ok=false on a non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 422 })));
    const res = await launchCall({ companyKey: 'ck', suid: 's1', name: 'R', phone: '+2760', timezone: 'UTC', values: {} });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(422);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism jobixLaunchClient`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the client**

```ts
export interface LaunchInput {
  companyKey: string; suid: string; name: string; phone: string;
  timezone: string; values: Record<string, unknown>;
}
export interface LaunchResult { ok: boolean; status: number; body: unknown }

const DEFAULT_BASE = 'https://dashboard-api.jobix.ai';

export async function launchCall(input: LaunchInput, baseUrl: string = DEFAULT_BASE): Promise<LaunchResult> {
  const res = await fetch(`${baseUrl}/v1/customer/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      company_key: input.companyKey,
      customer_data: {
        main: { suid: input.suid, name: input.name, phone: input.phone, timezone: input.timezone },
        values: input.values,
      },
    }),
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  return { ok: res.ok, status: res.status, body };
}

export type LaunchFn = (input: LaunchInput) => Promise<LaunchResult>;
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism jobixLaunchClient`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/jobix/launchClient.ts server/test/jobixLaunchClient.test.ts
git commit -m "feat(calls): Jobix customer/save launch client"
```

---

## Task 7: Worker orchestration

**Files:**
- Create: `server/src/calls/runCallQueue.ts`
- Test: `server/test/runCallQueue.test.ts`

The worker is injected with an `encKey`, a `LaunchFn` (so tests use a stub, never real HTTP), and a `checkSuppressed` hook (the deferred-POPIA seam — defaults to never suppress).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createAgent } from '../src/repos/callAgents.js';
import { createCampaign, addRecipientsFromCsv, approveCampaign, getCampaign, listRecipients } from '../src/repos/callCampaigns.js';
import { runCallQueue } from '../src/calls/runCallQueue.js';

const KEY = Buffer.alloc(32, 7);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function approved(n: number) {
  const t = await createTenant(pool);
  const a = await createAgent(pool, KEY, { tenantId: t.id, label: 'A', companyKey: 'company-key-xyz', valuesSchema: [] });
  const c = await createCampaign(pool, { tenantId: t.id, agentId: a.id, name: 'C', audienceType: 'csv' });
  await addRecipientsFromCsv(pool, { tenantId: t.id, campaignId: c.id, agentId: a.id,
    rows: Array.from({ length: n }, (_, i) => ({ name: `n${i}`, phone: `+2760000000${i}` })) });
  await approveCampaign(pool, t.id, c.id, null);
  return { t, a, c };
}

describe('runCallQueue', () => {
  it('launches pending recipients via the injected LaunchFn and decrypts the right company_key', async () => {
    const { t, c } = await approved(2);
    const launch = vi.fn(async () => ({ ok: true, status: 200, body: { status: 'accepted' } }));
    const summary = await runCallQueue(pool, KEY, { batchSize: 10, maxAttempts: 3 }, launch);
    expect(summary.launched).toBe(2);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls[0][0].companyKey).toBe('company-key-xyz');
    const recips = await listRecipients(pool, t.id, c.id, {});
    expect(recips.recipients.every(r => r.status === 'launched')).toBe(true);
    expect((await getCampaign(pool, t.id, c.id))?.status).toBe('running');
  });

  it('marks a recipient failed on a non-2xx and retries it next run, then gives up at maxAttempts', async () => {
    const { t, c } = await approved(1);
    const launch = vi.fn(async () => ({ ok: false, status: 500, body: null }));
    await runCallQueue(pool, KEY, { batchSize: 10, maxAttempts: 2 }, launch);
    await runCallQueue(pool, KEY, { batchSize: 10, maxAttempts: 2 }, launch);
    const recips = await listRecipients(pool, t.id, c.id, {});
    expect(recips.recipients[0].status).toBe('failed');
    expect(recips.recipients[0].attempts).toBe(2);
    // exhausted → campaign completes (nothing retryable left)
    await runCallQueue(pool, KEY, { batchSize: 10, maxAttempts: 2 }, launch);
    expect((await getCampaign(pool, t.id, c.id))?.status).toBe('completed');
  });

  it('suppresses a recipient when checkSuppressed returns true (no launch)', async () => {
    const { t, c } = await approved(1);
    const launch = vi.fn(async () => ({ ok: true, status: 200, body: {} }));
    const summary = await runCallQueue(pool, KEY, { batchSize: 10, maxAttempts: 3 }, launch, async () => true);
    expect(launch).not.toHaveBeenCalled();
    expect(summary.suppressed).toBe(1);
    const recips = await listRecipients(pool, t.id, c.id, {});
    expect(recips.recipients[0].status).toBe('suppressed');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism runCallQueue`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the worker**

```ts
import type pg from 'pg';
import { getAgentForLaunch } from '../repos/callAgents.js';
import { claimPending, markLaunched, markFailed, completeFinishedCampaigns } from '../repos/callCampaigns.js';
import type { LaunchFn } from '../jobix/launchClient.js';
import { launchCall } from '../jobix/launchClient.js';

export type CheckSuppressed = (tenantId: string, phone: string) => Promise<boolean>;
const neverSuppressed: CheckSuppressed = async () => false;

export interface QueueOpts { batchSize: number; maxAttempts: number }
export interface QueueSummary { claimed: number; launched: number; failed: number; suppressed: number }

export async function runCallQueue(
  pool: pg.Pool, encKey: Buffer, opts: QueueOpts,
  launch: LaunchFn = launchCall, checkSuppressed: CheckSuppressed = neverSuppressed,
): Promise<QueueSummary> {
  const claimed = await claimPending(pool, opts.batchSize, opts.maxAttempts);
  const summary: QueueSummary = { claimed: claimed.length, launched: 0, failed: 0, suppressed: 0 };

  // cache decrypted agent keys per campaign to avoid repeated decrypts
  const agentCache = new Map<string, Awaited<ReturnType<typeof getAgentForLaunch>>>();

  for (const r of claimed) {
    try {
      if (await checkSuppressed(r.tenant_id, r.phone)) {
        await pool.query(`UPDATE call_campaign_recipients SET status = 'suppressed', updated_at = now() WHERE id = $1`, [r.id]);
        summary.suppressed++;
        continue;
      }
      const cacheKey = `${r.tenant_id}:${r.campaign_id}`;
      let agent = agentCache.get(cacheKey);
      if (agent === undefined) {
        const camp = await pool.query<{ agent_id: string }>(`SELECT agent_id FROM call_campaigns WHERE id = $1`, [r.campaign_id]);
        agent = camp.rows[0] ? await getAgentForLaunch(pool, encKey, r.tenant_id, camp.rows[0].agent_id) : null;
        agentCache.set(cacheKey, agent);
      }
      if (!agent) { await markFailed(pool, r.id, 'agent not found or key undecryptable'); summary.failed++; continue; }

      const res = await launch({
        companyKey: agent.companyKey, suid: r.suid, name: r.name, phone: r.phone,
        timezone: r.timezone ?? agent.defaultTimezone, values: r.values ?? {},
      });
      if (res.ok) { await markLaunched(pool, r.id, res.body); summary.launched++; }
      else { await markFailed(pool, r.id, `customer/save ${res.status}`); summary.failed++; }
    } catch (e) {
      await markFailed(pool, r.id, e instanceof Error ? e.message : String(e));
      summary.failed++;
    }
  }

  await completeFinishedCampaigns(pool, opts.maxAttempts);
  return summary;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism runCallQueue`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/calls/runCallQueue.ts server/test/runCallQueue.test.ts
git commit -m "feat(calls): outbound call queue worker (claim, launch, suppress hook)"
```

---

## Task 8: callAgents routes

**Files:**
- Create: `server/src/routes/callAgents.ts`
- Modify: `server/src/app.ts` (register)
- Test: `server/test/callAgents.routes.test.ts`

- [ ] **Step 1: Implement the routes**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { AppError, sendError } from '../util/errors.js';
import { createAgent, listAgents, updateAgent } from '../repos/callAgents.js';

function requireAdmin(ctx: ReturnType<typeof requireTenantCtx>): void {
  if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') {
    throw new AppError('forbidden', 403, 'Admin role required');
  }
}

const valuesSchema = z.array(z.object({ key: z.string().min(1), label: z.string().min(1), required: z.boolean(), type: z.string().optional() })).max(50);

export function registerCallAgentRoutes(app: FastifyInstance): void {
  app.post('/api/calls/agents', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const b = z.object({
        label: z.string().min(1).max(120),
        company_key: z.string().min(1).max(500),
        values_schema: valuesSchema.default([]),
        default_timezone: z.string().max(60).optional(),
      }).parse(req.body);
      const agent = await createAgent(app.pool, app.cfg.encKey, {
        tenantId: ctx.tenantId, label: b.label, companyKey: b.company_key,
        valuesSchema: b.values_schema, defaultTimezone: b.default_timezone, createdBy: ctx.userId,
      });
      reply.code(201).send({ agent });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/calls/agents', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      reply.send({ agents: await listAgents(app.pool, ctx.tenantId) });
    } catch (e) { sendError(reply, e); }
  });

  app.patch('/api/calls/agents/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const id = (req.params as { id: string }).id;
      const b = z.object({
        label: z.string().min(1).max(120).optional(),
        company_key: z.string().min(1).max(500).optional(),
        values_schema: valuesSchema.optional(),
        default_timezone: z.string().max(60).optional(),
        active: z.boolean().optional(),
      }).parse(req.body);
      const agent = await updateAgent(app.pool, app.cfg.encKey, ctx.tenantId, id, {
        label: b.label, companyKey: b.company_key, valuesSchema: b.values_schema,
        defaultTimezone: b.default_timezone, active: b.active,
      });
      if (!agent) throw new AppError('not_found', 404, 'Agent not found');
      reply.send({ agent });
    } catch (e) { sendError(reply, e); }
  });
}
```

- [ ] **Step 2: Register in `server/src/app.ts`**

Add the import near the other route imports and the registration alongside `registerCallAnalyticsRoutes(app);`:
```ts
import { registerCallAgentRoutes } from './routes/callAgents.js';
// ...
registerCallAgentRoutes(app);
```

- [ ] **Step 3: Write the route test**

Copy the `adminSession`/`nonAdminSession` helpers from `server/test/callAnalytics.routes.test.ts` (session + CSRF login, tenant_admin vs tenant_user).

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant, createUser } from './helpers/factories.js';
import { csrfFor, login } from './helpers/auth.js';

const KEY = Buffer.alloc(32, 1);
const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32), EMAILER_ENC_KEY: KEY.toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000', CRON_SECRET: 'c'.repeat(24),
});
let app: Awaited<ReturnType<typeof buildApp>>;
const pool = makePool();
beforeAll(async () => { app = await buildApp({ cfg }); });
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await pool.end(); });

async function adminSession() {
  const t = await createTenant(pool);
  await createUser(pool, { tenantId: t.id, email: 'admin@x.io', password: 'pw-12345678', role: 'tenant_admin' });
  const csrf = await csrfFor(app);
  const headers = await login(app, { email: 'admin@x.io', password: 'pw-12345678' }, csrf);
  return { tenantId: t.id, headers };
}
async function nonAdminSession(tenantId: string) {
  await createUser(pool, { tenantId, email: 'user@x.io', password: 'pw-12345678', role: 'tenant_user' });
  const csrf = await csrfFor(app);
  const headers = await login(app, { email: 'user@x.io', password: 'pw-12345678' }, csrf);
  return { headers };
}

describe('call agents routes', () => {
  it('creates an agent and never returns the company_key', async () => {
    const { headers } = await adminSession();
    const res = await app.inject({ method: 'POST', url: '/api/calls/agents', headers,
      payload: { label: 'Arrears', company_key: 'super-secret', values_schema: [{ key: 'unit_number', label: 'Unit', required: true }] } });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain('super-secret');
    const body = JSON.parse(res.body);
    expect(body.agent.hasKey).toBe(true);
    expect(body.agent).not.toHaveProperty('company_key');
  });

  it('403 for a non-admin', async () => {
    const { tenantId } = await adminSession();
    const { headers } = await nonAdminSession(tenantId);
    const res = await app.inject({ method: 'GET', url: '/api/calls/agents', headers });
    expect(res.statusCode).toBe(403);
  });

  it('404 patching another tenant\'s agent', async () => {
    const { headers } = await adminSession();
    const res = await app.inject({ method: 'PATCH', url: '/api/calls/agents/00000000-0000-0000-0000-000000000000', headers, payload: { label: 'x' } });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 4: Run the test**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism callAgents.routes`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/callAgents.ts server/src/app.ts server/test/callAgents.routes.test.ts
git commit -m "feat(calls): call agents routes (admin-gated, key write-only)"
```

---

## Task 9: callCampaigns routes

**Files:**
- Create: `server/src/routes/callCampaigns.ts`
- Modify: `server/src/app.ts` (register)
- Test: `server/test/callCampaigns.routes.test.ts`

CSV is accepted as a parsed JSON array of row objects in the request body (`{ source: 'csv', rows: [...] }`) — the frontend parses the file client-side and posts rows, avoiding a multipart dependency. Audience is `{ source: 'audience' }` using the campaign's stored `audience_type`/`audience_id`.

- [ ] **Step 1: Implement the routes**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { AppError, sendError } from '../util/errors.js';
import {
  createCampaign, getCampaign, listCampaigns, listRecipients,
  addRecipientsFromCsv, addRecipientsFromAudience,
  approveCampaign, pauseCampaign, resumeCampaign, cancelCampaign,
} from '../repos/callCampaigns.js';

function requireAdmin(ctx: ReturnType<typeof requireTenantCtx>): void {
  if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') {
    throw new AppError('forbidden', 403, 'Admin role required');
  }
}

async function loadCampaignOr404(app: FastifyInstance, tenantId: string, id: string) {
  const c = await getCampaign(app.pool, tenantId, id);
  if (!c) throw new AppError('not_found', 404, 'Campaign not found');
  return c;
}

export function registerCallCampaignRoutes(app: FastifyInstance): void {
  app.post('/api/calls/campaigns', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const b = z.object({
        agent_id: z.string().uuid(),
        name: z.string().min(1).max(160),
        audience_type: z.enum(['list', 'segment', 'csv']),
        audience_id: z.string().uuid().optional(),
        scheduled_for: z.string().datetime().optional(),
      }).parse(req.body);
      if ((b.audience_type === 'list' || b.audience_type === 'segment') && !b.audience_id) {
        throw new AppError('bad_request', 400, 'audience_id required for list/segment campaigns');
      }
      const c = await createCampaign(app.pool, {
        tenantId: ctx.tenantId, agentId: b.agent_id, name: b.name,
        audienceType: b.audience_type, audienceId: b.audience_id ?? null,
        scheduledFor: b.scheduled_for ? new Date(b.scheduled_for) : null, createdBy: ctx.userId,
      });
      reply.code(201).send({ campaign: c });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/calls/campaigns/:id/recipients', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const id = (req.params as { id: string }).id;
      const c = await loadCampaignOr404(app, ctx.tenantId, id);
      if (c.status !== 'draft') throw new AppError('invalid_state', 400, 'Recipients can only be added while draft');
      const b = z.discriminatedUnion('source', [
        z.object({ source: z.literal('csv'), rows: z.array(z.record(z.string())).min(1).max(10000) }),
        z.object({ source: z.literal('audience') }),
      ]).parse(req.body);
      const result = b.source === 'csv'
        ? await addRecipientsFromCsv(app.pool, { tenantId: ctx.tenantId, campaignId: id, agentId: c.agent_id, rows: b.rows })
        : await addRecipientsFromAudience(app.pool, { tenantId: ctx.tenantId, campaignId: id, agentId: c.agent_id,
            audienceType: c.audience_type as 'list' | 'segment', audienceId: c.audience_id as string });
      reply.send(result);
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/calls/campaigns', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      reply.send({ campaigns: await listCampaigns(app.pool, ctx.tenantId) });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/calls/campaigns/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      reply.send({ campaign: await loadCampaignOr404(app, ctx.tenantId, (req.params as { id: string }).id) });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/calls/campaigns/:id/recipients', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const id = (req.params as { id: string }).id;
      await loadCampaignOr404(app, ctx.tenantId, id);
      const q = z.object({
        status: z.enum(['pending','queued','launched','failed','suppressed','completed','canceled']).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      }).parse(req.query);
      reply.send(await listRecipients(app.pool, ctx.tenantId, id, q));
    } catch (e) { sendError(reply, e); }
  });

  const action = (path: string, fn: (tenantId: string, id: string, userId?: string) => Promise<unknown>) =>
    app.post(`/api/calls/campaigns/:id/${path}`, async (req, reply) => {
      try {
        const ctx = requireTenantCtx(req); requireAdmin(ctx);
        const id = (req.params as { id: string }).id;
        reply.send({ campaign: await fn(ctx.tenantId, id, ctx.userId) });
      } catch (e) { sendError(reply, e); }
    });

  action('approve', (tid, id, uid) => approveCampaign(app.pool, tid, id, uid ?? null));
  action('pause',   (tid, id) => pauseCampaign(app.pool, tid, id));
  action('resume',  (tid, id) => resumeCampaign(app.pool, tid, id));
  action('cancel',  (tid, id) => cancelCampaign(app.pool, tid, id));
}
```

- [ ] **Step 2: Register in `server/src/app.ts`**

```ts
import { registerCallCampaignRoutes } from './routes/callCampaigns.js';
// ...
registerCallCampaignRoutes(app);
```

- [ ] **Step 3: Write the route test**

Reuse the same `adminSession`/`nonAdminSession` helper shape as Task 8.

```ts
// imports + cfg + app/pool setup identical to Task 8's test (copy them), plus:
import { createAgent } from '../src/repos/callAgents.js';

async function agent(tenantId: string) {
  return createAgent(Buffer.alloc(32, 1) && pool as never, Buffer.alloc(32, 1), // see note
    { tenantId, label: 'A', companyKey: 'k', valuesSchema: [{ key: 'unit_number', label: 'Unit', required: true }] });
}

describe('call campaigns routes', () => {
  it('create → add CSV recipients → approve happy path', async () => {
    const { tenantId, headers } = await adminSession();
    const a = await createAgent(pool, Buffer.alloc(32, 1), { tenantId, label: 'A', companyKey: 'k',
      valuesSchema: [{ key: 'unit_number', label: 'Unit', required: true }] });
    const create = await app.inject({ method: 'POST', url: '/api/calls/campaigns', headers,
      payload: { agent_id: a.id, name: 'Q3', audience_type: 'csv' } });
    expect(create.statusCode).toBe(201);
    const campaignId = JSON.parse(create.body).campaign.id;

    const recips = await app.inject({ method: 'POST', url: `/api/calls/campaigns/${campaignId}/recipients`, headers,
      payload: { source: 'csv', rows: [{ name: 'Renier', phone: '+27609381283', unit_number: '103' }] } });
    expect(JSON.parse(recips.body).added).toBe(1);

    const approve = await app.inject({ method: 'POST', url: `/api/calls/campaigns/${campaignId}/approve`, headers });
    expect(approve.statusCode).toBe(200);
    expect(JSON.parse(approve.body).campaign.status).toBe('approved');
  });

  it('approve fails (400) when a required value is missing', async () => {
    const { tenantId, headers } = await adminSession();
    const a = await createAgent(pool, Buffer.alloc(32, 1), { tenantId, label: 'A', companyKey: 'k',
      valuesSchema: [{ key: 'unit_number', label: 'Unit', required: true }] });
    const create = await app.inject({ method: 'POST', url: '/api/calls/campaigns', headers,
      payload: { agent_id: a.id, name: 'Bad', audience_type: 'csv' } });
    const campaignId = JSON.parse(create.body).campaign.id;
    await app.inject({ method: 'POST', url: `/api/calls/campaigns/${campaignId}/recipients`, headers,
      payload: { source: 'csv', rows: [{ name: 'NoUnit', phone: '+2760' }] } }); // row rejected → 0 added
    const approve = await app.inject({ method: 'POST', url: `/api/calls/campaigns/${campaignId}/approve`, headers });
    expect(approve.statusCode).toBe(400);
  });

  it('403 for a non-admin', async () => {
    const { tenantId } = await adminSession();
    const { headers } = await nonAdminSession(tenantId);
    const res = await app.inject({ method: 'GET', url: '/api/calls/campaigns', headers });
    expect(res.statusCode).toBe(403);
  });
});
```

> Remove the placeholder `agent()` helper sketch — use the inline `createAgent(pool, Buffer.alloc(32,1), {...})` calls shown in the `it` blocks.

- [ ] **Step 4: Run the test**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism callCampaigns.routes`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/callCampaigns.ts server/src/app.ts server/test/callCampaigns.routes.test.ts
git commit -m "feat(calls): call campaigns routes (create/recipients/approve/pause/cancel)"
```

---

## Task 10: Cron route — process-call-queue

**Files:**
- Modify: `server/src/routes/cron.ts`
- Modify: `vercel.json`
- Test: `server/test/cronCallQueue.route.test.ts`

- [ ] **Step 1: Add the cron route in `cron.ts`**

Add the import and a new `cron(...)` registration alongside the existing ones (inside `registerCronRoutes`, using the file's existing `cron(url, handler)` helper and `requireCronAuth`):
```ts
import { runCallQueue } from '../calls/runCallQueue.js';
// ... inside registerCronRoutes, with the other cron(...) calls:
cron('/v1/cron/process-call-queue', async (req, reply) => {
  try {
    requireCronAuth(req, app.cfg.cronSecret);
    const summary = await runCallQueue(app.pool, app.cfg.encKey, { batchSize: app.cfg.cronBatchSize ?? 50, maxAttempts: 3 });
    return reply.send({ ok: true, ...summary });
  } catch (e) { sendError(reply, e); }
});
```
> If `app.cfg.cronBatchSize` doesn't exist, use a literal `50`.

- [ ] **Step 2: Add the schedule to `vercel.json`**

Add to the `crons` array:
```json
{ "path": "/v1/cron/process-call-queue", "schedule": "* * * * *" }
```

- [ ] **Step 3: Write the test**

```ts
// cfg + buildApp + pool setup identical to Task 8 (copy), plus:
import { createTenant } from './helpers/factories.js';
import { createAgent } from '../src/repos/callAgents.js';
import { createCampaign, addRecipientsFromCsv, approveCampaign } from '../src/repos/callCampaigns.js';

describe('POST /v1/cron/process-call-queue', () => {
  it('401 without the cron secret', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/cron/process-call-queue' });
    expect(res.statusCode).toBe(401);
  });

  it('claims and reports a summary with the cron secret', async () => {
    const t = await createTenant(pool);
    const a = await createAgent(pool, Buffer.alloc(32, 1), { tenantId: t.id, label: 'A', companyKey: 'k', valuesSchema: [] });
    const c = await createCampaign(pool, { tenantId: t.id, agentId: a.id, name: 'C', audienceType: 'csv' });
    await addRecipientsFromCsv(pool, { tenantId: t.id, campaignId: c.id, agentId: a.id, rows: [{ name: 'n', phone: '+2760' }] });
    await approveCampaign(pool, t.id, c.id, null);
    const res = await app.inject({ method: 'POST', url: '/v1/cron/process-call-queue', headers: { authorization: 'Bearer ' + 'c'.repeat(24) } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(JSON.parse(res.body).claimed).toBe(1);
    // real fetch to dashboard-api will fail in CI → recipient ends 'failed', which is fine; we assert it was claimed.
  });
});
```
> Because this route uses the **real** `launchCall` (network), the second test only asserts the recipient was claimed and a summary returned; the launch itself fails closed in CI. Worker success-path behaviour is covered by Task 7 with a stubbed `LaunchFn`.

- [ ] **Step 4: Run the test**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism cronCallQueue.route`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/cron.ts vercel.json server/test/cronCallQueue.route.test.ts
git commit -m "feat(calls): process-call-queue cron + vercel schedule"
```

---

## Task 11: Close the loop — linkResultBySuid hook in v1Jobix

**Files:**
- Modify: `server/src/routes/v1Jobix.ts`
- Test: `server/test/v1JobixLink.route.test.ts`

- [ ] **Step 1: Add the post-ingest hook in `v1Jobix.ts`**

Import the helper and add the call after `ingestJobixCall(...)` returns, before the 202:
```ts
import { linkResultBySuid } from '../repos/callCampaigns.js';
// ... after: const out = await ingestJobixCall({ ... });
const cd = (b.customer_data ?? {}) as Record<string, unknown>;
const main = (cd.main ?? {}) as Record<string, unknown>;
const suid = String((main.suid ?? b.suid ?? '') || '');
const outcome = (b.call_outcome ?? b.outcome ?? null) as string | null;
if (suid) {
  await linkResultBySuid(app.pool, ctx.tenantId, suid, out.messageId, outcome);
}
return reply.code(202).send({ created: out.created, message_id: out.messageId });
```
> `linkResultBySuid` is a no-op (returns false) when no recipient matches that `suid` — so inbound calls not from a campaign are unaffected.

- [ ] **Step 2: Write the integration test**

Copy the `withKey` helper from `server/test/v1Jobix.route.test.ts` (creates a tenant + api key, returns `{ t, key }`). This test launches a recipient, then simulates Jobix's result webhook hitting the existing endpoint with the same `suid`.

```ts
// cfg + buildApp + pool setup identical to Task 8 (copy), plus the withKey helper from v1Jobix.route.test.ts
import { createAgent } from '../src/repos/callAgents.js';
import { createCampaign, addRecipientsFromCsv, approveCampaign, listRecipients } from '../src/repos/callCampaigns.js';

describe('v1/jobix/calls links outbound recipients by suid', () => {
  it('a result with a known suid completes the recipient and links the message', async () => {
    const { t, key } = await withKey();
    const a = await createAgent(pool, Buffer.alloc(32, 1), { tenantId: t.id, label: 'A', companyKey: 'k', valuesSchema: [] });
    const c = await createCampaign(pool, { tenantId: t.id, agentId: a.id, name: 'C', audienceType: 'csv' });
    await addRecipientsFromCsv(pool, { tenantId: t.id, campaignId: c.id, agentId: a.id, rows: [{ name: 'Renier', phone: '+2760' }] });
    await approveCampaign(pool, t.id, c.id, null);
    const before = await listRecipients(pool, t.id, c.id, {});
    const suid = before.recipients[0].suid;

    const res = await app.inject({ method: 'POST', url: '/v1/jobix/calls',
      headers: { authorization: `Bearer ${key}` },
      payload: { customer_data: { main: { suid } }, call_outcome: 'completed', call_summary: 'done', timestamp: '2026-06-07T10:00:00Z' } });
    expect(res.statusCode).toBe(202);

    const after = await listRecipients(pool, t.id, c.id, {});
    expect(after.recipients[0].status).toBe('completed');
    expect(after.recipients[0].outcome).toBe('completed');
    expect(after.recipients[0].result_message_id).toBeTruthy();
  });

  it('a result with an unknown suid still ingests (no error, recipient untouched)', async () => {
    const { key } = await withKey();
    const res = await app.inject({ method: 'POST', url: '/v1/jobix/calls',
      headers: { authorization: `Bearer ${key}` },
      payload: { customer_data: { main: { suid: 'totally-unknown' } }, call_summary: 'x', timestamp: '2026-06-07T10:00:00Z' } });
    expect(res.statusCode).toBe(202);
  });
});
```

- [ ] **Step 3: Run the test**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism v1JobixLink.route`
Expected: PASS (2 tests).

- [ ] **Step 4: Run the existing Jobix tests to confirm non-regression**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism v1Jobix`
Expected: existing `v1Jobix.route` tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/v1Jobix.ts server/test/v1JobixLink.route.test.ts
git commit -m "feat(calls): link Jobix call results back to campaign recipients by suid"
```

---

## Task 12: Frontend client lib

**Files:**
- Create: `web/src/lib/callCampaigns.ts`

- [ ] **Step 1: Implement the typed client**

```ts
import { api } from '../api';

export interface ValuesField { key: string; label: string; required: boolean; type?: string }
export interface CallAgent { id: string; label: string; values_schema: ValuesField[]; default_timezone: string; active: boolean; hasKey: true }
export type RecipientStatus = 'pending' | 'queued' | 'launched' | 'failed' | 'suppressed' | 'completed' | 'canceled';
export type CampaignStatus = 'draft' | 'approved' | 'running' | 'paused' | 'completed' | 'canceled';
export interface CampaignCounts { pending: number; queued: number; launched: number; failed: number; suppressed: number; completed: number; canceled: number }
export interface CallCampaign {
  id: string; agent_id: string; name: string; audience_type: 'list' | 'segment' | 'csv';
  audience_id: string | null; status: CampaignStatus; recipient_count: number; counts: CampaignCounts;
  scheduled_for: string | null; created_at: string;
}
export interface Recipient {
  id: string; suid: string; name: string; phone: string; values: Record<string, unknown>;
  status: RecipientStatus; attempts: number; last_error: string | null; outcome: string | null;
  result_message_id: string | null;
}

export const listAgents = () => api<{ agents: CallAgent[] }>('/api/calls/agents');
export const createAgent = (body: { label: string; company_key: string; values_schema: ValuesField[]; default_timezone?: string }) =>
  api<{ agent: CallAgent }>('/api/calls/agents', { method: 'POST', body: JSON.stringify(body) });
export const updateAgent = (id: string, patch: Partial<{ label: string; company_key: string; values_schema: ValuesField[]; default_timezone: string; active: boolean }>) =>
  api<{ agent: CallAgent }>(`/api/calls/agents/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const listCampaigns = () => api<{ campaigns: CallCampaign[] }>('/api/calls/campaigns');
export const getCampaign = (id: string) => api<{ campaign: CallCampaign }>(`/api/calls/campaigns/${id}`);
export const createCampaign = (body: { agent_id: string; name: string; audience_type: 'list' | 'segment' | 'csv'; audience_id?: string; scheduled_for?: string }) =>
  api<{ campaign: CallCampaign }>('/api/calls/campaigns', { method: 'POST', body: JSON.stringify(body) });
export const addCsvRecipients = (id: string, rows: Record<string, string>[]) =>
  api<{ added: number; errors: string[] }>(`/api/calls/campaigns/${id}/recipients`, { method: 'POST', body: JSON.stringify({ source: 'csv', rows }) });
export const addAudienceRecipients = (id: string) =>
  api<{ added: number; errors: string[] }>(`/api/calls/campaigns/${id}/recipients`, { method: 'POST', body: JSON.stringify({ source: 'audience' }) });
export const listRecipients = (id: string, status?: RecipientStatus) =>
  api<{ recipients: Recipient[]; total: number }>(`/api/calls/campaigns/${id}/recipients${status ? `?status=${status}` : ''}`);
export const approveCampaign = (id: string) => api<{ campaign: CallCampaign }>(`/api/calls/campaigns/${id}/approve`, { method: 'POST' });
export const pauseCampaign = (id: string) => api<{ campaign: CallCampaign }>(`/api/calls/campaigns/${id}/pause`, { method: 'POST' });
export const cancelCampaign = (id: string) => api<{ campaign: CallCampaign }>(`/api/calls/campaigns/${id}/cancel`, { method: 'POST' });
```

- [ ] **Step 2: Type-check via the web build (done at Task 14). Commit.**

```bash
git add web/src/lib/callCampaigns.ts
git commit -m "feat(web): typed client for call campaigns + agents"
```

---

## Task 13: Frontend page — agents + campaigns

**Files:**
- Create: `web/src/pages/CallCampaigns.tsx`
- Modify: `web/src/routes.tsx`
- Modify: `web/src/components/AppShell.tsx`

This page follows the existing page pattern (default export, `useState`/`useEffect`, shared components from `../components/*`, `useToast()`). It has two sections: **Agents** (register/list) and **Campaigns** (list → builder → detail). CSV is parsed client-side into row objects.

- [ ] **Step 1: Implement the page**

```tsx
import { useEffect, useState } from 'react';
import {
  listAgents, createAgent, listCampaigns, createCampaign, getCampaign,
  addCsvRecipients, addAudienceRecipients, listRecipients,
  approveCampaign, pauseCampaign, cancelCampaign,
  type CallAgent, type CallCampaign, type Recipient, type ValuesField,
} from '../lib/callCampaigns';
import { PageHeader } from '../components/PageHeader';
import { Card } from '../components/Card';
import { Table, Th, Td } from '../components/Table';
import { Button } from '../components/Button';
import { Input, Field } from '../components/Input';
import { EmptyState } from '../components/EmptyState';
import { useToast } from '../components/Toast';

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const cells = line.split(',');
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = (cells[i] ?? '').trim(); });
    return row;
  });
}

export default function CallCampaigns() {
  const toast = useToast();
  const [agents, setAgents] = useState<CallAgent[]>([]);
  const [campaigns, setCampaigns] = useState<CallCampaign[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);

  const reload = async () => {
    const [a, c] = await Promise.all([listAgents(), listCampaigns()]);
    setAgents(a.agents); setCampaigns(c.campaigns);
  };
  useEffect(() => { reload().catch(e => toast.error((e as Error).message)); }, []);
  useEffect(() => {
    if (!selected) { setRecipients([]); return; }
    listRecipients(selected).then(r => setRecipients(r.recipients)).catch(e => toast.error((e as Error).message));
  }, [selected]);

  // --- Agent form state ---
  const [agentLabel, setAgentLabel] = useState(''); const [agentKey, setAgentKey] = useState('');
  const [agentSchema, setAgentSchema] = useState<ValuesField[]>([]);
  async function submitAgent(e: React.FormEvent) {
    e.preventDefault();
    try {
      await createAgent({ label: agentLabel, company_key: agentKey, values_schema: agentSchema });
      setAgentLabel(''); setAgentKey(''); setAgentSchema([]); await reload(); toast.success('Agent registered');
    } catch (err) { toast.error((err as Error).message); }
  }

  // --- Campaign create state ---
  const [campName, setCampName] = useState(''); const [campAgent, setCampAgent] = useState('');
  async function submitCampaign(e: React.FormEvent) {
    e.preventDefault();
    try {
      const c = await createCampaign({ agent_id: campAgent, name: campName, audience_type: 'csv' });
      setCampName(''); await reload(); setSelected(c.campaign.id); toast.success('Draft created — add recipients');
    } catch (err) { toast.error((err as Error).message); }
  }

  async function onCsv(file: File) {
    if (!selected) return;
    try {
      const rows = parseCsv(await file.text());
      const res = await addCsvRecipients(selected, rows);
      await reload(); listRecipients(selected).then(r => setRecipients(r.recipients));
      toast.success(`${res.added} added${res.errors.length ? `, ${res.errors.length} skipped` : ''}`);
    } catch (err) { toast.error((err as Error).message); }
  }

  async function doApprove(id: string) {
    try { await approveCampaign(id); await reload(); toast.success('Approved — calls will launch'); }
    catch (err) { toast.error((err as Error).message); }
  }

  return (
    <div>
      <PageHeader title="Outbound Calls" subtitle="Launch Jobix call campaigns" />

      <Card>
        <h3>Jobix agents</h3>
        {agents.length === 0 ? <EmptyState title="No agents yet" /> : (
          <Table>
            <thead><tr><Th>Label</Th><Th>Fields</Th><Th>Active</Th></tr></thead>
            <tbody>{agents.map(a => (
              <tr key={a.id}><Td>{a.label}</Td><Td>{a.values_schema.map(f => f.key).join(', ')}</Td><Td>{a.active ? 'yes' : 'no'}</Td></tr>
            ))}</tbody>
          </Table>
        )}
        <form onSubmit={submitAgent}>
          <Field label="Label"><Input value={agentLabel} onChange={e => setAgentLabel(e.target.value)} required /></Field>
          <Field label="Jobix company_key"><Input value={agentKey} onChange={e => setAgentKey(e.target.value)} required /></Field>
          {/* values_schema builder: one row per field */}
          {agentSchema.map((f, i) => (
            <div key={i} style={{ display: 'flex', gap: 8 }}>
              <Input placeholder="key" value={f.key} onChange={e => setAgentSchema(s => s.map((x, j) => j === i ? { ...x, key: e.target.value } : x))} />
              <Input placeholder="label" value={f.label} onChange={e => setAgentSchema(s => s.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} />
              <label><input type="checkbox" checked={f.required} onChange={e => setAgentSchema(s => s.map((x, j) => j === i ? { ...x, required: e.target.checked } : x))} /> required</label>
            </div>
          ))}
          <Button type="button" onClick={() => setAgentSchema(s => [...s, { key: '', label: '', required: false }])}>+ field</Button>
          <Button type="submit">Register agent</Button>
        </form>
      </Card>

      <Card>
        <h3>Campaigns</h3>
        <form onSubmit={submitCampaign}>
          <Field label="Name"><Input value={campName} onChange={e => setCampName(e.target.value)} required /></Field>
          <Field label="Agent">
            <select value={campAgent} onChange={e => setCampAgent(e.target.value)} required>
              <option value="">Select…</option>
              {agents.filter(a => a.active).map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </Field>
          <Button type="submit">New draft (CSV)</Button>
        </form>
        {campaigns.length === 0 ? <EmptyState title="No campaigns yet" /> : (
          <Table>
            <thead><tr><Th>Name</Th><Th>Status</Th><Th>Launched/Total</Th><Th></Th></tr></thead>
            <tbody>{campaigns.map(c => (
              <tr key={c.id}>
                <Td><a onClick={() => setSelected(c.id)} style={{ cursor: 'pointer' }}>{c.name}</a></Td>
                <Td>{c.status}</Td>
                <Td>{c.counts.launched + c.counts.completed}/{c.recipient_count}</Td>
                <Td>
                  {c.status === 'draft' && <Button onClick={() => doApprove(c.id)}>Approve</Button>}
                  {(c.status === 'approved' || c.status === 'running') && <Button onClick={() => pauseCampaign(c.id).then(reload)}>Pause</Button>}
                  {c.status !== 'canceled' && c.status !== 'completed' && <Button onClick={() => cancelCampaign(c.id).then(reload)}>Cancel</Button>}
                </Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </Card>

      {selected && (
        <Card>
          <h3>Recipients</h3>
          <input type="file" accept=".csv" onChange={e => e.target.files && onCsv(e.target.files[0])} />
          <Table>
            <thead><tr><Th>Name</Th><Th>Phone</Th><Th>Status</Th><Th>Outcome</Th></tr></thead>
            <tbody>{recipients.map(r => (
              <tr key={r.id}><Td>{r.name}</Td><Td>{r.phone}</Td><Td>{r.status}</Td><Td>{r.outcome ?? '—'}</Td></tr>
            ))}</tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
```
> Adapt component prop names to the real `../components/*` signatures if they differ (e.g. `Field`/`Input` props). The web build in Task 14 will surface any mismatch to fix.

- [ ] **Step 2: Add the route in `web/src/routes.tsx`**

```tsx
import CallCampaigns from './pages/CallCampaigns';
// inside the children array under /t/:tenantId:
{ path: 'outbound-calls', element: <CallCampaigns /> },
```

- [ ] **Step 3: Add a nav link in `web/src/components/AppShell.tsx`**

Follow the existing nav-item pattern in that file (match how `calls` or `lists` is linked) and add an "Outbound Calls" entry pointing to `outbound-calls`.

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/CallCampaigns.tsx web/src/routes.tsx web/src/components/AppShell.tsx
git commit -m "feat(web): outbound calls page (agents + campaigns + recipients)"
```

---

## Task 14: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full server test suite (serial)**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism`
Expected: ALL pass, including existing `jobix.*`, `callAnalytics.*`, `callFacts.*`, `handover.*`, `lineReport.*`, email suites (non-regression).

- [ ] **Step 2: Strict type-check + web build**

Run: `npm -w server run build` (or `tsc -p server` per the repo's script) then `npm -w web run build`
Expected: both succeed with no type errors. Fix any component prop mismatches surfaced by the web build.

- [ ] **Step 3: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "chore(calls): fixups from full build + test verification"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- §1 data model → Task 1. §2 repos → Tasks 2–5. §3 routes → Tasks 8–9. §4 worker + loop → Tasks 6,7,10,11. §5 frontend → Tasks 12–13. §7 error handling → covered across route/repo tasks (403/404/400, retry, decrypt failure). §8 deferred POPIA → `checkSuppressed` seam in Task 7 (+`suppressed` status in Task 1). §9 testing → every backend task is TDD; non-regression in Task 11/14. All spec sections map to a task.
- Known intentional gap (per spec §8): no consent/DNC enforcement — the `checkSuppressed` stub returns false. This is the documented fast-follow.

**Type consistency:** `ValuesField`, `RecipientStatus`, `CampaignStatus`, `CampaignCounts` defined in Task 2/3 and reused verbatim in the frontend lib (Task 12). Repo fn names (`createAgent`, `getAgentForLaunch`, `claimPending`, `markLaunched`, `markFailed`, `completeFinishedCampaigns`, `linkResultBySuid`, `addRecipientsFromCsv`, `addRecipientsFromAudience`, `validateRecipients`, `listRecipients`) are consistent between definition and call sites.

**Placeholder note:** Task 9's test contains a deliberately-removed `agent()` helper sketch — the step text instructs using the inline `createAgent(...)` calls; do not implement the sketch.
