# Jobix Call Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reusable "fire a Jobix call" primitive driven by Jobix's webhook-trigger node — a per-tenant trigger registry (token + configurable placement + `{{placeholder}}` payload template), a `fireTrigger` server action, a fire log, admin CRUD/test/fire routes, and a "Jobix Call Triggers" section on the Webhooks page.

**Architecture:** Two additive tables (`jobix_triggers`, `jobix_trigger_fires`). A pure `validateTriggerUrl` guard, a `jobixTriggers` repo (crypto + persistence), a `fireTrigger` primitive (templating + token placement + HTTP + logging, injectable-free but fetch-stubbable in tests), thin admin-gated routes, and a frontend section on the existing `EventWebhooks.tsx`. Fully isolated from the `call_agents`/`customer/save` path.

**Tech Stack:** Fastify + TypeScript (NodeNext ESM, `.js` import extensions), Postgres via `pg.Pool`, `node-pg-migrate` (`.cjs`), Zod, Vitest (serial against the Neon test branch), React + Vite with an `api<T>()` fetch helper.

**Reference spec:** `docs/superpowers/specs/2026-06-08-jobix-call-triggers-design.md`

---

## Conventions (read once)

- **Encryption:** `import { encrypt, decrypt } from '../crypto/enc.js'`. `encrypt(plaintext: string, key: Buffer): Buffer`, `decrypt(blob: Buffer, key: Buffer): string`. Key = `app.cfg.encKey` in routes, passed explicitly into repos/primitive.
- **Auth:** `import { requireTenantCtx } from '../auth/ctx.js'`. Copy this local helper into the route module:
  ```ts
  function requireAdmin(ctx: ReturnType<typeof requireTenantCtx>): void {
    if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') {
      throw new AppError('forbidden', 403, 'Admin role required');
    }
  }
  ```
- **Errors:** `import { AppError, sendError } from '../util/errors.js'`. `AppError(code, httpStatus, message, details?)`. Wrap each handler in `try { ... } catch (e) { sendError(reply, e); }`.
- **Repos:** named exports; first arg `pool: pg.Pool`; parameterized `$1`; `jsonb` via `JSON.stringify`; tenant scoping always `WHERE tenant_id = $1`.
- **Tests — run command** (migrate the test branch first):
  ```bash
  DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server run migrate
  TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism <name>
  ```
- **Test helpers:** `makePool`, `truncateAll` from `./helpers/db.js`; `createTenant`, `createUser` from `./helpers/factories.js`; `csrfFor`, `login` from `./helpers/auth.js`. Route tests build the app with `buildApp({ cfg })` and drive it with `app.inject`. Copy the `cfg`/`adminSession`/`nonAdminSession` setup from the existing `server/test/callAgents.routes.test.ts`.
- **Web build check:** `npm -w web run build`.

---

## File Structure

**Create:**
- `server/migrations/1700000000032_jobix_triggers.cjs`
- `server/src/jobix/validateTriggerUrl.ts`
- `server/src/repos/jobixTriggers.ts`
- `server/src/jobix/fireTrigger.ts`
- `server/src/routes/jobixTriggers.ts`
- `web/src/lib/jobixTriggers.ts`
- Test files alongside each

**Modify:**
- `server/src/app.ts` — register the new route module
- `web/src/pages/EventWebhooks.tsx` — add the "Jobix Call Triggers" section

> Migration number: if the unbuilt B1 `call_actions` migration has already taken `032`, rename this to `1700000000033_jobix_triggers.cjs` — no other change.

---

## Task 1: Migration — the two tables

**Files:**
- Create: `server/migrations/1700000000032_jobix_triggers.cjs`

- [ ] **Step 1: Write the migration**

```js
/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.createTable('jobix_triggers', {
    id:               { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:        { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    label:            { type: 'text', notNull: true },
    url:              { type: 'text', notNull: true },
    token_encrypted:  { type: 'bytea', notNull: true },
    token_placement:  { type: 'text', notNull: true, default: 'bearer',
                        check: "token_placement IN ('bearer','header','query','body')" },
    token_param:      { type: 'text' },
    payload_template: { type: 'text', notNull: true, default: '{}' },
    active:           { type: 'boolean', notNull: true, default: true },
    last_fired_at:    { type: 'timestamptz' },
    created_by:       { type: 'uuid', references: 'users(id)', onDelete: 'SET NULL' },
    created_at:       { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at:       { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('jobix_triggers', 'jobix_triggers_tenant_label_uniq', { unique: ['tenant_id', 'label'] });
  pgm.createIndex('jobix_triggers', ['tenant_id']);

  pgm.createTable('jobix_trigger_fires', {
    id:               { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:        { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    trigger_id:       { type: 'uuid', notNull: true, references: 'jobix_triggers(id)', onDelete: 'CASCADE' },
    source:           { type: 'text', notNull: true, default: 'manual',
                        check: "source IN ('manual','test','event','abe')" },
    vars:             { type: 'jsonb', notNull: true, default: '{}' },
    http_status:      { type: 'integer' },
    ok:               { type: 'boolean', notNull: true },
    response_snippet: { type: 'text' },
    error:            { type: 'text' },
    created_by:       { type: 'uuid', references: 'users(id)', onDelete: 'SET NULL' },
    created_at:       { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('jobix_trigger_fires', ['tenant_id', { name: 'created_at', sort: 'DESC' }]);
  pgm.createIndex('jobix_trigger_fires', ['trigger_id']);
};

exports.down = (pgm) => {
  pgm.dropTable('jobix_trigger_fires');
  pgm.dropTable('jobix_triggers');
};
```

- [ ] **Step 2: Apply to the test branch**

Run: `DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server run migrate`
Expected: migration `1700000000032_jobix_triggers` runs, "Migrations complete!".

- [ ] **Step 3: Commit**

```bash
git add server/migrations/1700000000032_jobix_triggers.cjs
git commit -m "feat(triggers): migration for jobix_triggers + jobix_trigger_fires"
```

---

## Task 2: `validateTriggerUrl` guard

**Files:**
- Create: `server/src/jobix/validateTriggerUrl.ts`
- Test: `server/test/validateTriggerUrl.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { validateTriggerUrl } from '../src/jobix/validateTriggerUrl.js';

describe('validateTriggerUrl', () => {
  it('accepts the jobix https url', () => {
    expect(() => validateTriggerUrl('https://dashboard-api.jobix.ai/automation/trigger/webhook')).not.toThrow();
  });
  it('rejects http://', () => {
    expect(() => validateTriggerUrl('http://dashboard-api.jobix.ai/x')).toThrow();
  });
  it('rejects a non-url', () => {
    expect(() => validateTriggerUrl('not a url')).toThrow();
  });
  it('rejects localhost and private/link-local IPs', () => {
    for (const u of [
      'https://localhost/x', 'https://127.0.0.1/x', 'https://10.1.2.3/x',
      'https://192.168.0.1/x', 'https://169.254.169.254/x', 'https://172.16.0.1/x',
    ]) {
      expect(() => validateTriggerUrl(u), u).toThrow();
    }
  });
  it('accepts a normal public https host', () => {
    expect(() => validateTriggerUrl('https://example.com/hook')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism validateTriggerUrl`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { AppError } from '../util/errors.js';

const PRIVATE_HOST = /^(0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.)/;

export function validateTriggerUrl(raw: string): void {
  let u: URL;
  try { u = new URL(raw); } catch { throw new AppError('invalid_url', 400, 'Invalid URL'); }
  if (u.protocol !== 'https:') throw new AppError('invalid_url', 400, 'URL must use https');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '::1' || PRIVATE_HOST.test(host)) {
    throw new AppError('invalid_url', 400, 'URL host is not allowed');
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism validateTriggerUrl`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/jobix/validateTriggerUrl.ts server/test/validateTriggerUrl.test.ts
git commit -m "feat(triggers): https + private-IP url guard"
```

---

## Task 3: `jobixTriggers` repo — CRUD + crypto

**Files:**
- Create: `server/src/repos/jobixTriggers.ts`
- Test: `server/test/jobixTriggers.repo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createTrigger, listTriggers, getTriggerForFire, updateTrigger, deleteTrigger } from '../src/repos/jobixTriggers.js';

const KEY = Buffer.alloc(32, 9);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

const base = { label: 'Callback', token: 'jbx-secret-token', tokenPlacement: 'bearer' as const, payloadTemplate: '{"name":"{{name}}"}' };

describe('jobixTriggers repo', () => {
  it('creates a trigger, encrypts the token, never returns it, defaults the url', async () => {
    const t = await createTenant(pool);
    const trig = await createTrigger(pool, KEY, { tenantId: t.id, ...base });
    expect(trig.url).toBe('https://dashboard-api.jobix.ai/automation/trigger/webhook');
    expect(trig.hasToken).toBe(true);
    expect(JSON.stringify(trig)).not.toContain('jbx-secret-token');
    const list = await listTriggers(pool, t.id);
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list[0])).not.toContain('jbx-secret-token');
  });

  it('getTriggerForFire decrypts the token (server-only)', async () => {
    const t = await createTenant(pool);
    const trig = await createTrigger(pool, KEY, { tenantId: t.id, ...base });
    const f = await getTriggerForFire(pool, KEY, t.id, trig.id);
    expect(f?.token).toBe('jbx-secret-token');
    expect(f?.tokenPlacement).toBe('bearer');
  });

  it('rejects a non-bearer placement without token_param', async () => {
    const t = await createTenant(pool);
    await expect(createTrigger(pool, KEY, { tenantId: t.id, ...base, tokenPlacement: 'header' }))
      .rejects.toThrow();
  });

  it('rejects an http url', async () => {
    const t = await createTenant(pool);
    await expect(createTrigger(pool, KEY, { tenantId: t.id, ...base, url: 'http://x.io/y' }))
      .rejects.toThrow();
  });

  it('updateTrigger rotates the token and toggles active', async () => {
    const t = await createTenant(pool);
    const trig = await createTrigger(pool, KEY, { tenantId: t.id, ...base });
    await updateTrigger(pool, KEY, t.id, trig.id, { token: 'new-token', active: false });
    const f = await getTriggerForFire(pool, KEY, t.id, trig.id);
    expect(f?.token).toBe('new-token');
    expect(f?.active).toBe(false);
  });

  it('deleteTrigger removes it; cross-tenant getTriggerForFire returns null', async () => {
    const t1 = await createTenant(pool); const t2 = await createTenant(pool);
    const trig = await createTrigger(pool, KEY, { tenantId: t1.id, ...base });
    expect(await getTriggerForFire(pool, KEY, t2.id, trig.id)).toBeNull();
    expect(await deleteTrigger(pool, t1.id, trig.id)).toBe(true);
    expect(await getTriggerForFire(pool, KEY, t1.id, trig.id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism jobixTriggers.repo`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type pg from 'pg';
import { encrypt, decrypt } from '../crypto/enc.js';
import { AppError } from '../util/errors.js';
import { validateTriggerUrl } from '../jobix/validateTriggerUrl.js';

export type TokenPlacement = 'bearer' | 'header' | 'query' | 'body';
const DEFAULT_URL = 'https://dashboard-api.jobix.ai/automation/trigger/webhook';

export interface TriggerPublic {
  id: string; tenant_id: string; label: string; url: string;
  token_placement: TokenPlacement; token_param: string | null; payload_template: string;
  active: boolean; last_fired_at: Date | null; hasToken: true;
  created_at: Date; updated_at: Date;
}
export interface TriggerForFire {
  id: string; tenantId: string; label: string; url: string; token: string;
  tokenPlacement: TokenPlacement; tokenParam: string | null; payloadTemplate: string; active: boolean;
}

interface CreateInput {
  tenantId: string; label: string; url?: string; token: string;
  tokenPlacement: TokenPlacement; tokenParam?: string | null; payloadTemplate: string; createdBy?: string;
}

const PUBLIC_COLS =
  'id, tenant_id, label, url, token_placement, token_param, payload_template, active, last_fired_at, created_at, updated_at';

function toPublic(row: Record<string, unknown>): TriggerPublic {
  return {
    id: row.id as string, tenant_id: row.tenant_id as string, label: row.label as string, url: row.url as string,
    token_placement: row.token_placement as TokenPlacement, token_param: (row.token_param as string) ?? null,
    payload_template: row.payload_template as string, active: row.active as boolean,
    last_fired_at: (row.last_fired_at as Date) ?? null, hasToken: true,
    created_at: row.created_at as Date, updated_at: row.updated_at as Date,
  };
}

function assertPlacement(placement: TokenPlacement, param: string | null | undefined): void {
  if (placement !== 'bearer' && !param) {
    throw new AppError('token_param_required', 400, `token_param is required for placement '${placement}'`);
  }
}

export async function createTrigger(pool: pg.Pool, key: Buffer, input: CreateInput): Promise<TriggerPublic> {
  const url = (input.url && input.url.trim()) || DEFAULT_URL;
  validateTriggerUrl(url);
  assertPlacement(input.tokenPlacement, input.tokenParam);
  const enc = encrypt(input.token, key);
  const r = await pool.query(
    `INSERT INTO jobix_triggers (tenant_id, label, url, token_encrypted, token_placement, token_param, payload_template, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${PUBLIC_COLS}`,
    [input.tenantId, input.label, url, enc, input.tokenPlacement, input.tokenParam ?? null, input.payloadTemplate, input.createdBy ?? null]);
  return toPublic(r.rows[0]);
}

export async function listTriggers(pool: pg.Pool, tenantId: string): Promise<TriggerPublic[]> {
  const r = await pool.query(`SELECT ${PUBLIC_COLS} FROM jobix_triggers WHERE tenant_id = $1 ORDER BY label`, [tenantId]);
  return r.rows.map(toPublic);
}

export async function getTriggerForFire(pool: pg.Pool, key: Buffer, tenantId: string, id: string): Promise<TriggerForFire | null> {
  const r = await pool.query<{ id: string; tenant_id: string; label: string; url: string; token_encrypted: Buffer;
    token_placement: TokenPlacement; token_param: string | null; payload_template: string; active: boolean }>(
    `SELECT id, tenant_id, label, url, token_encrypted, token_placement, token_param, payload_template, active
     FROM jobix_triggers WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id, tenantId: row.tenant_id, label: row.label, url: row.url, token: decrypt(row.token_encrypted, key),
    tokenPlacement: row.token_placement, tokenParam: row.token_param, payloadTemplate: row.payload_template, active: row.active,
  };
}

interface UpdateInput {
  label?: string; url?: string; token?: string; tokenPlacement?: TokenPlacement;
  tokenParam?: string | null; payloadTemplate?: string; active?: boolean;
}

export async function updateTrigger(pool: pg.Pool, key: Buffer, tenantId: string, id: string, patch: UpdateInput): Promise<TriggerPublic | null> {
  if (patch.url !== undefined) validateTriggerUrl((patch.url && patch.url.trim()) || DEFAULT_URL);
  if (patch.tokenPlacement !== undefined && patch.tokenPlacement !== 'bearer' && patch.tokenParam === undefined) {
    // placement changed to a param-requiring one but no param supplied — check existing row
    const cur = await pool.query<{ token_param: string | null }>(`SELECT token_param FROM jobix_triggers WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
    assertPlacement(patch.tokenPlacement, cur.rows[0]?.token_param ?? null);
  } else if (patch.tokenPlacement !== undefined) {
    assertPlacement(patch.tokenPlacement, patch.tokenParam ?? null);
  }
  const sets: string[] = []; const params: unknown[] = [];
  const set = (frag: string, val: unknown) => { params.push(val); sets.push(`${frag} = $${params.length}`); };
  if (patch.label !== undefined) set('label', patch.label);
  if (patch.url !== undefined) set('url', (patch.url && patch.url.trim()) || DEFAULT_URL);
  if (patch.token !== undefined) set('token_encrypted', encrypt(patch.token, key));
  if (patch.tokenPlacement !== undefined) set('token_placement', patch.tokenPlacement);
  if (patch.tokenParam !== undefined) set('token_param', patch.tokenParam);
  if (patch.payloadTemplate !== undefined) set('payload_template', patch.payloadTemplate);
  if (patch.active !== undefined) set('active', patch.active);
  if (sets.length === 0) {
    const r = await pool.query(`SELECT ${PUBLIC_COLS} FROM jobix_triggers WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
    return r.rows[0] ? toPublic(r.rows[0]) : null;
  }
  params.push(tenantId, id);
  const r = await pool.query(
    `UPDATE jobix_triggers SET ${sets.join(', ')}, updated_at = now()
     WHERE tenant_id = $${params.length - 1} AND id = $${params.length} RETURNING ${PUBLIC_COLS}`, params);
  return r.rows[0] ? toPublic(r.rows[0]) : null;
}

export async function deleteTrigger(pool: pg.Pool, tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM jobix_triggers WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return (r.rowCount ?? 0) > 0;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism jobixTriggers.repo`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/repos/jobixTriggers.ts server/test/jobixTriggers.repo.test.ts
git commit -m "feat(triggers): jobixTriggers repo (encrypted token, url-guarded CRUD)"
```

---

## Task 4: `jobixTriggers` repo — fire log

**Files:**
- Modify: `server/src/repos/jobixTriggers.ts`
- Test: `server/test/jobixTriggerFires.repo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createTrigger, recordFire, listFires, touchLastFired, getTriggerForFire } from '../src/repos/jobixTriggers.js';

const KEY = Buffer.alloc(32, 9);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function trig(tenantId: string) {
  return createTrigger(pool, KEY, { tenantId, label: 'L', token: 'k', tokenPlacement: 'bearer', payloadTemplate: '{}' });
}

describe('jobixTriggers repo — fire log', () => {
  it('records fires and lists them newest-first, scoped to tenant+trigger', async () => {
    const t = await createTenant(pool); const tr = await trig(t.id);
    await recordFire(pool, { tenantId: t.id, triggerId: tr.id, source: 'manual', vars: { name: 'R' }, httpStatus: 200, ok: true, responseSnippet: 'accepted', error: null, createdBy: null });
    await recordFire(pool, { tenantId: t.id, triggerId: tr.id, source: 'test', vars: {}, httpStatus: 500, ok: false, responseSnippet: null, error: 'HTTP 500', createdBy: null });
    const { fires, total } = await listFires(pool, t.id, tr.id, {});
    expect(total).toBe(2);
    expect(fires).toHaveLength(2);
    expect(fires[0].source).toBe('test'); // newest first
    expect(fires[0].ok).toBe(false);
  });

  it('touchLastFired sets last_fired_at', async () => {
    const t = await createTenant(pool); const tr = await trig(t.id);
    await touchLastFired(pool, tr.id);
    const f = await getTriggerForFire(pool, KEY, t.id, tr.id);
    expect(f).toBeTruthy();
    const row = await pool.query(`SELECT last_fired_at FROM jobix_triggers WHERE id = $1`, [tr.id]);
    expect(row.rows[0].last_fired_at).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism jobixTriggerFires.repo`
Expected: FAIL — `recordFire`/`listFires`/`touchLastFired` not exported.

- [ ] **Step 3: Implement (append to `jobixTriggers.ts`)**

```ts
export type FireSource = 'manual' | 'test' | 'event' | 'abe';

export interface FireRow {
  id: string; tenant_id: string; trigger_id: string; source: FireSource;
  vars: Record<string, unknown>; http_status: number | null; ok: boolean;
  response_snippet: string | null; error: string | null; created_by: string | null; created_at: Date;
}

interface RecordFireInput {
  tenantId: string; triggerId: string; source: FireSource; vars: Record<string, unknown>;
  httpStatus: number | null; ok: boolean; responseSnippet: string | null; error: string | null; createdBy: string | null;
}

export async function recordFire(pool: pg.Pool, f: RecordFireInput): Promise<void> {
  await pool.query(
    `INSERT INTO jobix_trigger_fires (tenant_id, trigger_id, source, vars, http_status, ok, response_snippet, error, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [f.tenantId, f.triggerId, f.source, JSON.stringify(f.vars ?? {}), f.httpStatus, f.ok,
     f.responseSnippet ? f.responseSnippet.slice(0, 2000) : null, f.error ? f.error.slice(0, 2000) : null, f.createdBy]);
}

export async function listFires(pool: pg.Pool, tenantId: string, triggerId: string, opts: { limit?: number; offset?: number }): Promise<{ fires: FireRow[]; total: number }> {
  const total = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM jobix_trigger_fires WHERE tenant_id = $1 AND trigger_id = $2`, [tenantId, triggerId]);
  const r = await pool.query<FireRow>(
    `SELECT * FROM jobix_trigger_fires WHERE tenant_id = $1 AND trigger_id = $2
     ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
    [tenantId, triggerId, opts.limit ?? 50, opts.offset ?? 0]);
  return { fires: r.rows, total: Number(total.rows[0].n) };
}

export async function touchLastFired(pool: pg.Pool, id: string): Promise<void> {
  await pool.query(`UPDATE jobix_triggers SET last_fired_at = now(), updated_at = now() WHERE id = $1`, [id]);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism jobixTriggerFires.repo`
Expected: PASS (2 tests). Re-run `jobixTriggers.repo` — still PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/repos/jobixTriggers.ts server/test/jobixTriggerFires.repo.test.ts
git commit -m "feat(triggers): fire log repo (recordFire/listFires/touchLastFired)"
```

---

## Task 5: `fireTrigger` primitive

**Files:**
- Create: `server/src/jobix/fireTrigger.ts`
- Test: `server/test/fireTrigger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createTrigger, updateTrigger, listFires } from '../src/repos/jobixTriggers.js';
import { fireTrigger } from '../src/jobix/fireTrigger.js';

const KEY = Buffer.alloc(32, 9);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); await vi.restoreAllMocks(); });

function okFetch() {
  return vi.fn(async () => new Response(JSON.stringify({ status: 'accepted' }), { status: 200 }));
}

describe('fireTrigger', () => {
  it('renders the template, sends bearer auth, records a fire, sets last_fired_at', async () => {
    const t = await createTenant(pool);
    const tr = await createTrigger(pool, KEY, { tenantId: t.id, label: 'L', token: 'tok-1',
      tokenPlacement: 'bearer', payloadTemplate: '{"name":"{{name}}","phone":"{{phone}}"}' });
    const f = okFetch(); vi.stubGlobal('fetch', f);
    const res = await fireTrigger(pool, KEY, { tenantId: t.id, triggerId: tr.id, vars: { name: 'Renier', phone: '+2760' }, source: 'manual' });
    expect(res.ok).toBe(true);
    expect(res.httpStatus).toBe(200);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://dashboard-api.jobix.ai/automation/trigger/webhook');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok-1', 'Content-Type': 'application/json' });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ name: 'Renier', phone: '+2760' });
    const { fires } = await listFires(pool, t.id, tr.id, {});
    expect(fires).toHaveLength(1);
    expect(fires[0].ok).toBe(true);
    const lf = await pool.query(`SELECT last_fired_at FROM jobix_triggers WHERE id = $1`, [tr.id]);
    expect(lf.rows[0].last_fired_at).not.toBeNull();
  });

  it('applies header placement', async () => {
    const t = await createTenant(pool);
    const tr = await createTrigger(pool, KEY, { tenantId: t.id, label: 'H', token: 'tok-2',
      tokenPlacement: 'header', tokenParam: 'X-Webhook-Token', payloadTemplate: '{}' });
    const f = okFetch(); vi.stubGlobal('fetch', f);
    await fireTrigger(pool, KEY, { tenantId: t.id, triggerId: tr.id, vars: {}, source: 'test' });
    expect((f.mock.calls[0][1] as RequestInit).headers).toMatchObject({ 'X-Webhook-Token': 'tok-2' });
  });

  it('applies query placement', async () => {
    const t = await createTenant(pool);
    const tr = await createTrigger(pool, KEY, { tenantId: t.id, label: 'Q', token: 'tok-3',
      tokenPlacement: 'query', tokenParam: 'token', payloadTemplate: '{}' });
    const f = okFetch(); vi.stubGlobal('fetch', f);
    await fireTrigger(pool, KEY, { tenantId: t.id, triggerId: tr.id, vars: {}, source: 'test' });
    expect(f.mock.calls[0][0]).toContain('token=tok-3');
  });

  it('applies body placement', async () => {
    const t = await createTenant(pool);
    const tr = await createTrigger(pool, KEY, { tenantId: t.id, label: 'B', token: 'tok-4',
      tokenPlacement: 'body', tokenParam: 'token', payloadTemplate: '{"x":1}' });
    const f = okFetch(); vi.stubGlobal('fetch', f);
    await fireTrigger(pool, KEY, { tenantId: t.id, triggerId: tr.id, vars: {}, source: 'test' });
    expect(JSON.parse((f.mock.calls[0][1] as RequestInit).body as string)).toEqual({ x: 1, token: 'tok-4' });
  });

  it('reports invalid_payload when the rendered template is not JSON', async () => {
    const t = await createTenant(pool);
    const tr = await createTrigger(pool, KEY, { tenantId: t.id, label: 'Bad', token: 'k',
      tokenPlacement: 'bearer', payloadTemplate: '{ not json {{name}}' });
    const f = okFetch(); vi.stubGlobal('fetch', f);
    const res = await fireTrigger(pool, KEY, { tenantId: t.id, triggerId: tr.id, vars: { name: 'x' }, source: 'test' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('invalid_payload');
    expect(f).not.toHaveBeenCalled();
    const { fires } = await listFires(pool, t.id, tr.id, {});
    expect(fires[0].ok).toBe(false);
  });

  it('collects unresolved placeholders', async () => {
    const t = await createTenant(pool);
    const tr = await createTrigger(pool, KEY, { tenantId: t.id, label: 'U', token: 'k',
      tokenPlacement: 'bearer', payloadTemplate: '{"a":"{{missing}}"}' });
    vi.stubGlobal('fetch', okFetch());
    const res = await fireTrigger(pool, KEY, { tenantId: t.id, triggerId: tr.id, vars: {}, source: 'test' });
    expect(res.unresolved).toContain('missing');
  });

  it('throws 400 when firing an inactive trigger (non-test)', async () => {
    const t = await createTenant(pool);
    const tr = await createTrigger(pool, KEY, { tenantId: t.id, label: 'Off', token: 'k', tokenPlacement: 'bearer', payloadTemplate: '{}' });
    await updateTrigger(pool, KEY, t.id, tr.id, { active: false });
    vi.stubGlobal('fetch', okFetch());
    await expect(fireTrigger(pool, KEY, { tenantId: t.id, triggerId: tr.id, vars: {}, source: 'manual' })).rejects.toThrow();
  });

  it('records ok=false on a network error', async () => {
    const t = await createTenant(pool);
    const tr = await createTrigger(pool, KEY, { tenantId: t.id, label: 'Net', token: 'k', tokenPlacement: 'bearer', payloadTemplate: '{}' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom'); }));
    const res = await fireTrigger(pool, KEY, { tenantId: t.id, triggerId: tr.id, vars: {}, source: 'test' });
    expect(res.ok).toBe(false);
    expect(res.httpStatus).toBeNull();
    expect(res.error).toContain('boom');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism fireTrigger`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type pg from 'pg';
import { AppError } from '../util/errors.js';
import { getTriggerForFire, recordFire, touchLastFired, type FireSource } from '../repos/jobixTriggers.js';

export interface FireResult {
  ok: boolean; httpStatus: number | null; responseSnippet: string | null;
  error: string | null; renderedPayload: string; unresolved: string[];
}

interface FireArgs { tenantId: string; triggerId: string; vars: Record<string, string>; source: FireSource; userId?: string | null }

function render(template: string, vars: Record<string, string>): { text: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const text = template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    if (v === undefined || v === null) { unresolved.push(key); return ''; }
    return JSON.stringify(String(v)).slice(1, -1); // escape but keep inside the template's quotes
  });
  return { text, unresolved };
}

export async function fireTrigger(pool: pg.Pool, encKey: Buffer, args: FireArgs): Promise<FireResult> {
  const t = await getTriggerForFire(pool, encKey, args.tenantId, args.triggerId);
  if (!t) throw new AppError('not_found', 404, 'Trigger not found');
  if (!t.active && args.source !== 'test') throw new AppError('trigger_inactive', 400, 'Trigger is not active');

  const { text, unresolved } = render(t.payloadTemplate, args.vars ?? {});

  let bodyObj: Record<string, unknown>;
  try { bodyObj = JSON.parse(text) as Record<string, unknown>; }
  catch {
    const result: FireResult = { ok: false, httpStatus: null, responseSnippet: null, error: 'invalid_payload', renderedPayload: text, unresolved };
    await recordFire(pool, { tenantId: args.tenantId, triggerId: args.triggerId, source: args.source, vars: args.vars ?? {},
      httpStatus: null, ok: false, responseSnippet: null, error: 'invalid_payload', createdBy: args.userId ?? null });
    await touchLastFired(pool, args.triggerId);
    return result;
  }

  let url = t.url;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (t.tokenPlacement === 'bearer') headers['Authorization'] = `Bearer ${t.token}`;
  else if (t.tokenPlacement === 'header' && t.tokenParam) headers[t.tokenParam] = t.token;
  else if (t.tokenPlacement === 'query' && t.tokenParam) { const u = new URL(url); u.searchParams.set(t.tokenParam, t.token); url = u.toString(); }
  else if (t.tokenPlacement === 'body' && t.tokenParam) bodyObj[t.tokenParam] = t.token;

  const renderedPayload = JSON.stringify(bodyObj);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let result: FireResult;
  try {
    const res = await fetch(url, { method: 'POST', headers, body: renderedPayload, signal: ctrl.signal });
    const snippet = (await res.text().catch(() => '')).slice(0, 2000);
    result = { ok: res.ok, httpStatus: res.status, responseSnippet: snippet, error: res.ok ? null : `HTTP ${res.status}`, renderedPayload, unresolved };
  } catch (e) {
    result = { ok: false, httpStatus: null, responseSnippet: null, error: e instanceof Error ? e.message : String(e), renderedPayload, unresolved };
  } finally { clearTimeout(timer); }

  await recordFire(pool, { tenantId: args.tenantId, triggerId: args.triggerId, source: args.source, vars: args.vars ?? {},
    httpStatus: result.httpStatus, ok: result.ok, responseSnippet: result.responseSnippet, error: result.error, createdBy: args.userId ?? null });
  await touchLastFired(pool, args.triggerId);
  return result;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism fireTrigger`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/jobix/fireTrigger.ts server/test/fireTrigger.test.ts
git commit -m "feat(triggers): fireTrigger primitive (template + token placement + log)"
```

---

## Task 6: Routes + register in app.ts

**Files:**
- Create: `server/src/routes/jobixTriggers.ts`
- Modify: `server/src/app.ts`
- Test: `server/test/jobixTriggers.routes.test.ts`

- [ ] **Step 1: Implement the routes**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { AppError, sendError } from '../util/errors.js';
import { createTrigger, listTriggers, updateTrigger, deleteTrigger, listFires } from '../repos/jobixTriggers.js';
import { fireTrigger } from '../jobix/fireTrigger.js';

function requireAdmin(ctx: ReturnType<typeof requireTenantCtx>): void {
  if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') {
    throw new AppError('forbidden', 403, 'Admin role required');
  }
}

const placement = z.enum(['bearer', 'header', 'query', 'body']);
const vars = z.record(z.string()).default({});

export function registerJobixTriggerRoutes(app: FastifyInstance): void {
  app.post('/api/jobix-triggers', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const b = z.object({
        label: z.string().min(1).max(120),
        url: z.string().max(500).optional(),
        token: z.string().min(1).max(2000),
        token_placement: placement.default('bearer'),
        token_param: z.string().max(120).optional(),
        payload_template: z.string().min(1).max(20000),
      }).parse(req.body);
      const trig = await createTrigger(app.pool, app.cfg.encKey, {
        tenantId: ctx.tenantId, label: b.label, url: b.url, token: b.token,
        tokenPlacement: b.token_placement, tokenParam: b.token_param, payloadTemplate: b.payload_template, createdBy: ctx.userId,
      });
      reply.code(201).send({ trigger: trig });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/jobix-triggers', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      reply.send({ triggers: await listTriggers(app.pool, ctx.tenantId) });
    } catch (e) { sendError(reply, e); }
  });

  app.patch('/api/jobix-triggers/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const id = (req.params as { id: string }).id;
      const b = z.object({
        label: z.string().min(1).max(120).optional(),
        url: z.string().max(500).optional(),
        token: z.string().min(1).max(2000).optional(),
        token_placement: placement.optional(),
        token_param: z.string().max(120).nullable().optional(),
        payload_template: z.string().min(1).max(20000).optional(),
        active: z.boolean().optional(),
      }).parse(req.body);
      const trig = await updateTrigger(app.pool, app.cfg.encKey, ctx.tenantId, id, {
        label: b.label, url: b.url, token: b.token, tokenPlacement: b.token_placement,
        tokenParam: b.token_param, payloadTemplate: b.payload_template, active: b.active,
      });
      if (!trig) throw new AppError('not_found', 404, 'Trigger not found');
      reply.send({ trigger: trig });
    } catch (e) { sendError(reply, e); }
  });

  app.delete('/api/jobix-triggers/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const ok = await deleteTrigger(app.pool, ctx.tenantId, (req.params as { id: string }).id);
      if (!ok) throw new AppError('not_found', 404, 'Trigger not found');
      reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/jobix-triggers/:id/test', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const id = (req.params as { id: string }).id;
      const b = z.object({ vars }).parse(req.body ?? {});
      const result = await fireTrigger(app.pool, app.cfg.encKey, { tenantId: ctx.tenantId, triggerId: id, vars: b.vars, source: 'test', userId: ctx.userId });
      reply.send({ result });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/jobix-triggers/:id/fire', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const id = (req.params as { id: string }).id;
      const b = z.object({ vars }).parse(req.body ?? {});
      const result = await fireTrigger(app.pool, app.cfg.encKey, { tenantId: ctx.tenantId, triggerId: id, vars: b.vars, source: 'manual', userId: ctx.userId });
      reply.send({ result });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/jobix-triggers/:id/fires', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const id = (req.params as { id: string }).id;
      const q = z.object({ limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional() }).parse(req.query);
      reply.send(await listFires(app.pool, ctx.tenantId, id, q));
    } catch (e) { sendError(reply, e); }
  });
}
```

- [ ] **Step 2: Register in `server/src/app.ts`**

Add the import near the other route imports and the call alongside the other `register*Routes(app)` calls (sync variant):
```ts
import { registerJobixTriggerRoutes } from './routes/jobixTriggers.js';
// ...
registerJobixTriggerRoutes(app);
```

- [ ] **Step 3: Write the route test**

Copy the `cfg` / `buildApp` / `pool` / `adminSession` / `nonAdminSession` setup from `server/test/callAgents.routes.test.ts` (verbatim — same helpers). Then:

```ts
import { vi } from 'vitest';
// after the standard setup (app, pool, adminSession, nonAdminSession):

const okFetch = () => vi.fn(async () => new Response(JSON.stringify({ status: 'accepted' }), { status: 200 }));

describe('jobix triggers routes', () => {
  it('creates a trigger and never returns the token', async () => {
    const { headers } = await adminSession();
    const res = await app.inject({ method: 'POST', url: '/api/jobix-triggers', headers,
      payload: { label: 'CB', token: 'super-secret-token', payload_template: '{"name":"{{name}}"}' } });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain('super-secret-token');
    expect(JSON.parse(res.body).trigger.hasToken).toBe(true);
  });

  it('400 on a non-bearer placement without token_param', async () => {
    const { headers } = await adminSession();
    const res = await app.inject({ method: 'POST', url: '/api/jobix-triggers', headers,
      payload: { label: 'X', token: 't', token_placement: 'header', payload_template: '{}' } });
    expect(res.statusCode).toBe(400);
  });

  it('400 on an http url', async () => {
    const { headers } = await adminSession();
    const res = await app.inject({ method: 'POST', url: '/api/jobix-triggers', headers,
      payload: { label: 'Y', token: 't', url: 'http://x.io', payload_template: '{}' } });
    expect(res.statusCode).toBe(400);
  });

  it('test fires via the (stubbed) fetch and returns a FireResult', async () => {
    const { headers } = await adminSession();
    const create = await app.inject({ method: 'POST', url: '/api/jobix-triggers', headers,
      payload: { label: 'T', token: 't', payload_template: '{"name":"{{name}}"}' } });
    const id = JSON.parse(create.body).trigger.id;
    vi.stubGlobal('fetch', okFetch());
    const res = await app.inject({ method: 'POST', url: `/api/jobix-triggers/${id}/test`, headers, payload: { vars: { name: 'R' } } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).result.ok).toBe(true);
    vi.unstubAllGlobals();
  });

  it('403 for a non-admin', async () => {
    const { tenantId } = await adminSession();
    const { headers } = await nonAdminSession(tenantId);
    const res = await app.inject({ method: 'GET', url: '/api/jobix-triggers', headers });
    expect(res.statusCode).toBe(403);
  });

  it('404 deleting another tenant\\'s trigger', async () => {
    const { headers } = await adminSession();
    const res = await app.inject({ method: 'DELETE', url: '/api/jobix-triggers/00000000-0000-0000-0000-000000000000', headers });
    expect(res.statusCode).toBe(404);
  });
});
```
> Add `import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';` — include `vi`. Ensure `afterEach(() => vi.unstubAllGlobals())` or unstub inline so the stub doesn't leak.

- [ ] **Step 4: Run the test**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism jobixTriggers.routes`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/jobixTriggers.ts server/src/app.ts server/test/jobixTriggers.routes.test.ts
git commit -m "feat(triggers): admin-gated CRUD + test/fire/fires routes"
```

---

## Task 7: Frontend client lib

**Files:**
- Create: `web/src/lib/jobixTriggers.ts`

- [ ] **Step 1: Implement**

```ts
import { api } from '../api';

export type TokenPlacement = 'bearer' | 'header' | 'query' | 'body';
export interface JobixTrigger {
  id: string; label: string; url: string; token_placement: TokenPlacement; token_param: string | null;
  payload_template: string; active: boolean; last_fired_at: string | null; hasToken: true;
}
export interface FireResult {
  ok: boolean; httpStatus: number | null; responseSnippet: string | null;
  error: string | null; renderedPayload: string; unresolved: string[];
}
export interface FireRow {
  id: string; source: string; vars: Record<string, unknown>; http_status: number | null;
  ok: boolean; response_snippet: string | null; error: string | null; created_at: string;
}

export const listTriggers = () => api<{ triggers: JobixTrigger[] }>('/api/jobix-triggers');
export const createTrigger = (body: { label: string; url?: string; token: string; token_placement?: TokenPlacement; token_param?: string; payload_template: string }) =>
  api<{ trigger: JobixTrigger }>('/api/jobix-triggers', { method: 'POST', body: JSON.stringify(body) });
export const updateTrigger = (id: string, patch: Partial<{ label: string; url: string; token: string; token_placement: TokenPlacement; token_param: string | null; payload_template: string; active: boolean }>) =>
  api<{ trigger: JobixTrigger }>(`/api/jobix-triggers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
export const deleteTrigger = (id: string) =>
  api<{ ok: boolean }>(`/api/jobix-triggers/${id}`, { method: 'DELETE' });
export const testTrigger = (id: string, vars: Record<string, string>) =>
  api<{ result: FireResult }>(`/api/jobix-triggers/${id}/test`, { method: 'POST', body: JSON.stringify({ vars }) });
export const fireTrigger = (id: string, vars: Record<string, string>) =>
  api<{ result: FireResult }>(`/api/jobix-triggers/${id}/fire`, { method: 'POST', body: JSON.stringify({ vars }) });
export const listFires = (id: string) =>
  api<{ fires: FireRow[]; total: number }>(`/api/jobix-triggers/${id}/fires`);
```

- [ ] **Step 2: Type-check via web build (done in Task 9). Commit.**

```bash
git add web/src/lib/jobixTriggers.ts
git commit -m "feat(web): typed client for jobix triggers"
```

---

## Task 8: Webhooks-page UI — Jobix Call Triggers section

**Files:**
- Modify: `web/src/pages/EventWebhooks.tsx`

This adds a second section below the existing email event-webhooks content. **Read `EventWebhooks.tsx` first** to match its real imports, components (`Card`, `Table`/`Th`/`Td`, `Button`, `Input`/`Field`, `useToast`, `PageHeader`, `EmptyState`), and structure. Adapt the skeleton below to the real component props.

- [ ] **Step 1: Add a `JobixTriggers` section component and render it in the page**

Implement a section (either inline in `EventWebhooks.tsx` or a small sub-component in the same file) with this behavior, using the real shared components:

```tsx
// imports to add at top of EventWebhooks.tsx (merge with existing):
import {
  listTriggers, createTrigger, updateTrigger, deleteTrigger, testTrigger, fireTrigger, listFires,
  type JobixTrigger, type FireResult, type FireRow, type TokenPlacement,
} from '../lib/jobixTriggers';

// A self-contained section rendered beneath the existing event-webhooks content:
function JobixTriggersSection() {
  const toast = useToast();
  const [triggers, setTriggers] = useState<JobixTrigger[]>([]);
  const [result, setResult] = useState<FireResult | null>(null);
  const [fires, setFires] = useState<Record<string, FireRow[]>>({});

  // create form state
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('https://dashboard-api.jobix.ai/automation/trigger/webhook');
  const [token, setToken] = useState('');
  const [placement, setPlacement] = useState<TokenPlacement>('bearer');
  const [tokenParam, setTokenParam] = useState('');
  const [template, setTemplate] = useState('{\n  "name": "{{name}}",\n  "phone": "{{phone}}",\n  "reason": "{{context}}"\n}');

  const load = () => listTriggers().then(r => setTriggers(r.triggers)).catch(e => toast.error((e as Error).message));
  useEffect(() => { load(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      await createTrigger({ label, url, token, token_placement: placement, token_param: placement === 'bearer' ? undefined : tokenParam, payload_template: template });
      setLabel(''); setToken(''); setTokenParam(''); load(); toast.success('Trigger saved');
    } catch (err) { toast.error((err as Error).message); }
  }

  async function runTest(t: JobixTrigger) {
    const name = prompt('Test name?') ?? ''; const phone = prompt('Test phone?') ?? ''; const context = prompt('Context?') ?? '';
    try { const r = await testTrigger(t.id, { name, phone, context }); setResult(r.result); }
    catch (err) { toast.error((err as Error).message); }
  }
  async function runFire(t: JobixTrigger) {
    const name = prompt('Name?') ?? ''; const phone = prompt('Phone?') ?? ''; const context = prompt('Context?') ?? '';
    try { const r = await fireTrigger(t.id, { name, phone, context }); setResult(r.result); load(); toast.success(r.result.ok ? 'Fired' : 'Fired (see result)'); }
    catch (err) { toast.error((err as Error).message); }
  }
  async function toggleActive(t: JobixTrigger) {
    try { await updateTrigger(t.id, { active: !t.active }); load(); } catch (err) { toast.error((err as Error).message); }
  }
  async function remove(t: JobixTrigger) {
    if (!confirm(`Delete trigger "${t.label}"?`)) return;
    try { await deleteTrigger(t.id); load(); } catch (err) { toast.error((err as Error).message); }
  }
  async function showLog(t: JobixTrigger) {
    try { const r = await listFires(t.id); setFires(f => ({ ...f, [t.id]: r.fires })); } catch (err) { toast.error((err as Error).message); }
  }

  return (
    <Card>
      <h3>Jobix Call Triggers</h3>
      <p>Fire a Jobix call automation via its webhook-trigger node. Build the automation in Jobix, paste its token + the JSON payload Jobix expects, then Test until the response is green.</p>

      {triggers.length === 0 ? <EmptyState title="No triggers yet" /> : (
        <Table>
          <thead><tr><Th>Label</Th><Th>URL</Th><Th>Placement</Th><Th>Active</Th><Th>Last fired</Th><Th></Th></tr></thead>
          <tbody>{triggers.map(t => (
            <tr key={t.id}>
              <Td>{t.label}</Td>
              <Td title={t.url}>{t.url.length > 40 ? t.url.slice(0, 40) + '…' : t.url}</Td>
              <Td>{t.token_placement}{t.token_param ? ` (${t.token_param})` : ''}</Td>
              <Td>{t.active ? 'yes' : 'no'}</Td>
              <Td>{t.last_fired_at ? new Date(t.last_fired_at).toLocaleString() : '—'}</Td>
              <Td>
                <Button onClick={() => runTest(t)}>Test</Button>
                <Button onClick={() => runFire(t)} disabled={!t.active}>Trigger</Button>
                <Button onClick={() => toggleActive(t)}>{t.active ? 'Disable' : 'Enable'}</Button>
                <Button onClick={() => showLog(t)}>Log</Button>
                <Button onClick={() => remove(t)}>Delete</Button>
              </Td>
            </tr>
          ))}</tbody>
        </Table>
      )}

      {result && (
        <Card>
          <strong>Last result:</strong> {result.ok ? 'OK' : 'FAILED'} (HTTP {result.httpStatus ?? '—'})
          {result.error && <div>Error: {result.error}</div>}
          {result.unresolved.length > 0 && <div>Unresolved: {result.unresolved.join(', ')}</div>}
          <pre>Sent: {result.renderedPayload}</pre>
          {result.responseSnippet && <pre>Response: {result.responseSnippet}</pre>}
        </Card>
      )}

      {Object.entries(fires).map(([id, rows]) => (
        <div key={id}>
          <strong>Recent fires:</strong>
          <Table>
            <thead><tr><Th>When</Th><Th>Source</Th><Th>OK</Th><Th>HTTP</Th><Th>Error</Th></tr></thead>
            <tbody>{rows.map(r => (
              <tr key={r.id}><Td>{new Date(r.created_at).toLocaleString()}</Td><Td>{r.source}</Td><Td>{r.ok ? 'yes' : 'no'}</Td><Td>{r.http_status ?? '—'}</Td><Td>{r.error ?? ''}</Td></tr>
            ))}</tbody>
          </Table>
        </div>
      ))}

      <form onSubmit={create}>
        <Field label="Label"><Input value={label} onChange={e => setLabel(e.target.value)} required /></Field>
        <Field label="Webhook URL"><Input value={url} onChange={e => setUrl(e.target.value)} required /></Field>
        <Field label="Token"><Input value={token} onChange={e => setToken(e.target.value)} required /></Field>
        <Field label="Token placement">
          <select value={placement} onChange={e => setPlacement(e.target.value as TokenPlacement)}>
            <option value="bearer">Bearer header</option>
            <option value="header">Custom header</option>
            <option value="query">Query param</option>
            <option value="body">Body field</option>
          </select>
        </Field>
        {placement !== 'bearer' && (
          <Field label="Token param name"><Input value={tokenParam} onChange={e => setTokenParam(e.target.value)} required placeholder="e.g. X-Webhook-Token or token" /></Field>
        )}
        <Field label="Payload template (JSON, use {{name}} {{phone}} {{context}})">
          <textarea value={template} onChange={e => setTemplate(e.target.value)} rows={6} style={{ width: '100%', fontFamily: 'monospace' }} />
        </Field>
        <Button type="submit">Save trigger</Button>
      </form>
    </Card>
  );
}
```

Render `<JobixTriggersSection />` after the existing event-webhooks content in the page's returned JSX. If the page title is currently specific to event webhooks, update the `PageHeader` to "Webhooks" so both sections read coherently.

> The skeleton uses `prompt()`/`confirm()` for the Test/Trigger/Delete inputs to keep the slice small. If the codebase has a `Modal` component used elsewhere, prefer a small modal form instead — match what sibling pages do. The web build (Task 9) must pass either way; adapt component props to the real signatures.

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/EventWebhooks.tsx
git commit -m "feat(web): Jobix Call Triggers section on the Webhooks page"
```

---

## Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full server test suite (serial)**

Run: `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism`
Expected: ALL pass — the new `validateTriggerUrl`, `jobixTriggers.repo`, `jobixTriggerFires.repo`, `fireTrigger`, `jobixTriggers.routes` suites AND all pre-existing suites (including `eventWebhooks*`, `jobix*`, `callAgents*`, `callCampaigns*`) as non-regression.

- [ ] **Step 2: Server typecheck + web build**

Run: `npm -w server run build` then `npm -w web run build`
Expected: both succeed, no type errors. Fix any component prop mismatches surfaced by the web build.

- [ ] **Step 3: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "chore(triggers): fixups from full build + test verification"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** §1 data model → Task 1. §2 fireTrigger → Task 5. §3 repo → Tasks 3–4. §4 routes → Task 6. §5 security (url guard) → Task 2 + enforced in repo (Task 3) + routes (Task 6). §6 frontend → Tasks 7–8. §8 error handling → covered across Tasks 5–6 tests. §9 testing → every backend task is TDD; non-regression in Task 9. All spec sections map to a task.

**Type consistency:** `TokenPlacement`, `TriggerPublic`, `TriggerForFire`, `FireSource`, `FireRow`, `FireResult`, `RecordFireInput` defined in Tasks 3–5 and reused verbatim in the routes (Task 6) and frontend lib (Task 7). Repo fn names (`createTrigger`, `listTriggers`, `getTriggerForFire`, `updateTrigger`, `deleteTrigger`, `recordFire`, `listFires`, `touchLastFired`) consistent between definition and call sites. `fireTrigger(pool, encKey, args)` signature consistent across primitive, routes, and tests.

**Known intentional gaps (per spec §10):** no fire-log pruning; SSRF guard is https + literal private-IP only (no DNS-resolution check); templating assumes string-position placeholders. All documented.
