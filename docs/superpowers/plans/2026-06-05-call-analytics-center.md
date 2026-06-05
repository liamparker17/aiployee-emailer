# Call Analytics Center — Slice A (Read) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve the tenant Calls page into a Call Analytics Center — a multi-dimension big-picture dashboard plus an Excel-style sortable/filterable grid of individual calls with CSV export — by exposing the structured `call_facts` columns. Read-only.

**Architecture:** Additive. The `callAnalytics` repo LEFT-JOINs `call_facts` onto the existing inbound-message query (preserving the exact current call set — NOT the `calls` view, which also filters `source='jobix'`). New aggregate functions feed an expanded `/api/calls/breakdown`; `/api/calls` gains filters + sort; a new `/api/calls/export.csv` streams the grid. The React Calls page panels are extended in place. Handovers and the send pipeline are untouched.

**Tech Stack:** Node + TypeScript (ESM, `.js` specifiers), Fastify, Zod, node-pg, Vitest (serial, Neon test branch); React + Vite frontend (`web/`).

**Spec:** `docs/superpowers/specs/2026-06-05-call-analytics-center-design.md`

**Conventions (verified):**
- Repo functions take `pool` first, raw parameterized SQL, typed rows (`server/src/repos/callAnalytics.ts`).
- Backend tests: `makePool`/`truncateAll` (`./helpers/db.js`), `createTenant` (`./helpers/factories.js`); route tests `buildApp({cfg})` + `app.inject` with API key or session (see `server/test/callAnalytics.routes.test.ts` / `v1Emails.test.ts`).
- **Run one backend test file (serial, Neon test branch):**
  `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism test/<file>`
- **Strict backend build:** `npm -w server run build` (tsc). **Web build:** `npm -w web run build` (vite+tsc) — confirm the script name in `web/package.json`.
- **Read-hook note:** an "LSP-first" Read guard blocks large-file full reads and NO language server is installed — use scoped `offset`/`limit` reads or `git show`. New files are unaffected.

**Two sortable/groupable dimension allow-lists are shared across tasks — define them ONCE in the repo (Task 1) and reuse:**
- `SORT_COLUMNS`: `created_at→m.created_at, attribution_label→f.attribution_label, category→t.category, call_outcome→f.call_outcome, sentiment→f.sentiment, call_duration_seconds→f.call_duration_seconds, resolution_state→f.resolution_state`
- `BREAKDOWN_COLUMNS`: `attribution_label→f.attribution_label, category→t.category, call_outcome→f.call_outcome, sentiment→f.sentiment, resolution_state→f.resolution_state`

---

## Task 1: Widen `CallRow` + `listCalls` (structured columns, filters, sort)

**Files:**
- Modify: `server/src/repos/callAnalytics.ts`
- Test: `server/test/callAnalytics.repo.test.ts` (extend)

- [ ] **Step 1: Read** `server/src/repos/callAnalytics.ts` (106 lines; read scoped) to match style. Note the current `CallRow` and `listCalls`.

- [ ] **Step 2: Write the failing test** (append to `server/test/callAnalytics.repo.test.ts`; reuse its existing `pool`/setup). This helper seeds an inbound call with facts:
```ts
import { listCalls } from '../src/repos/callAnalytics.js';
// seed: an inbound jobix message + a call_facts row
async function seedCall(pool: import('pg').Pool, tenantId: string, opts: {
  content: string; attribution?: string; outcome?: string; sentiment?: string; resolution?: string;
}): Promise<string> {
  const th = await pool.query<{ id: string }>(
    `INSERT INTO agent_threads (tenant_id, jobix_thread_ref) VALUES ($1, 'jobix:'||gen_random_uuid()) RETURNING id`, [tenantId]);
  const m = await pool.query<{ id: string }>(
    `INSERT INTO agent_messages (thread_id, tenant_id, role, source, content, status)
     VALUES ($1,$2,'inbound','jobix',$3,'sent') RETURNING id`, [th.rows[0].id, tenantId, opts.content]);
  await pool.query(
    `INSERT INTO call_facts (tenant_id, message_id, attribution_label, call_outcome, sentiment, resolution_state)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,'open'))`,
    [tenantId, m.rows[0].id, opts.attribution ?? null, opts.outcome ?? null, opts.sentiment ?? null, opts.resolution ?? null]);
  return m.rows[0].id;
}

describe('listCalls structured filters + sort', () => {
  it('returns structured columns and filters by attribution/outcome/sentiment/resolution', async () => {
    const t = await createTenant(pool);
    await seedCall(pool, t.id, { content: 'arrears query', attribution: 'Accounts', outcome: 'completed', sentiment: 'neutral', resolution: 'open' });
    await seedCall(pool, t.id, { content: 'leak in unit', attribution: 'Maintenance', outcome: 'escalated', sentiment: 'negative', resolution: 'in_progress' });

    const all = await listCalls(pool, t.id, {});
    expect(all.total).toBe(2);
    expect(all.calls[0]).toHaveProperty('attribution_label');
    expect(all.calls[0]).toHaveProperty('resolution_state');

    const acct = await listCalls(pool, t.id, { attribution: 'Accounts' });
    expect(acct.total).toBe(1);
    expect(acct.calls[0].attribution_label).toBe('Accounts');

    expect((await listCalls(pool, t.id, { outcome: 'escalated' })).total).toBe(1);
    expect((await listCalls(pool, t.id, { sentiment: 'negative' })).total).toBe(1);
    expect((await listCalls(pool, t.id, { resolution: 'in_progress' })).total).toBe(1);
  });

  it('sorts by an allow-listed field asc/desc and rejects unknown sort gracefully (falls back to created_at)', async () => {
    const t = await createTenant(pool);
    await seedCall(pool, t.id, { content: 'a', attribution: 'Zeta' });
    await seedCall(pool, t.id, { content: 'b', attribution: 'Alpha' });
    const asc = await listCalls(pool, t.id, { sort: 'attribution_label', sortDir: 'asc' });
    expect(asc.calls.map(c => c.attribution_label)).toEqual(['Alpha', 'Zeta']);
    const bogus = await listCalls(pool, t.id, { sort: 'DROP TABLE' as never });
    expect(bogus.total).toBe(2); // no crash, falls back to created_at
  });
});
```

- [ ] **Step 3: Run, confirm FAIL** (new props/filters not present):
  `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism test/callAnalytics.repo.test.ts`

- [ ] **Step 4: Implement.** Replace the `CallRow` interface and `listCalls` (and widen `getCall`'s SELECT identically) with:
```ts
export interface CallRow {
  id: string; created_at: Date; content: string;
  category: string | null; severity: string | null;
  caller_name: string | null; caller_phone: string | null;
  attribution_label: string | null; call_type: string | null;
  call_outcome: string | null; sentiment: string | null;
  call_duration_seconds: number | null;
  callback_requested: boolean | null; escalation_requested: boolean | null;
  resolution_state: string | null;
}

// Allow-lists: map API field names to SQL columns. User input never reaches SQL directly.
const SORT_COLUMNS: Record<string, string> = {
  created_at: 'm.created_at', attribution_label: 'f.attribution_label', category: 't.category',
  call_outcome: 'f.call_outcome', sentiment: 'f.sentiment',
  call_duration_seconds: 'f.call_duration_seconds', resolution_state: 'f.resolution_state',
};
export const BREAKDOWN_COLUMNS: Record<string, string> = {
  attribution_label: 'f.attribution_label', category: 't.category',
  call_outcome: 'f.call_outcome', sentiment: 'f.sentiment', resolution_state: 'f.resolution_state',
};

const CALL_FROM = `agent_messages m
       LEFT JOIN call_facts f     ON f.message_id = m.id
       LEFT JOIN line_call_tags t ON t.message_id = m.id`;
const CALL_COLS = `m.id, m.created_at, m.content, t.category, t.severity,
       f.caller_name, f.caller_phone, f.attribution_label, f.call_type,
       f.call_outcome, f.sentiment, f.call_duration_seconds,
       f.callback_requested, f.escalation_requested, f.resolution_state`;

export interface ListCallsOpts {
  category?: string; search?: string; from?: Date; to?: Date; limit?: number; offset?: number;
  attribution?: string; outcome?: string; sentiment?: string; resolution?: string;
  callbackRequested?: boolean; escalationRequested?: boolean;
  sort?: string; sortDir?: 'asc' | 'desc';
}

export async function listCalls(pool: pg.Pool, tenantId: string, opts: ListCallsOpts): Promise<{ calls: CallRow[]; total: number }> {
  const where = [`m.tenant_id = $1`, `m.role = 'inbound'`];
  const params: unknown[] = [tenantId];
  const eq = (val: unknown, col: string) => { params.push(val); where.push(`${col} = $${params.length}`); };
  if (opts.category) eq(opts.category, 't.category');
  if (opts.search) { params.push('%' + opts.search + '%'); where.push(`m.content ILIKE $${params.length}`); }
  if (opts.from) { params.push(opts.from); where.push(`m.created_at >= $${params.length}`); }
  if (opts.to) { params.push(opts.to); where.push(`m.created_at < $${params.length}`); }
  if (opts.attribution) eq(opts.attribution, 'f.attribution_label');
  if (opts.outcome) eq(opts.outcome, 'f.call_outcome');
  if (opts.sentiment) eq(opts.sentiment, 'f.sentiment');
  if (opts.resolution) eq(opts.resolution, 'f.resolution_state');
  if (opts.callbackRequested !== undefined) eq(opts.callbackRequested, 'f.callback_requested');
  if (opts.escalationRequested !== undefined) eq(opts.escalationRequested, 'f.escalation_requested');
  const whereSql = where.join(' AND ');

  const totalR = await pool.query<{ n: string }>(`SELECT count(*)::text n FROM ${CALL_FROM} WHERE ${whereSql}`, params);

  const sortCol = SORT_COLUMNS[opts.sort ?? 'created_at'] ?? 'm.created_at';
  const dir = opts.sortDir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  params.push(limit); const limIdx = params.length;
  params.push(offset); const offIdx = params.length;
  const r = await pool.query<CallRow>(
    `SELECT ${CALL_COLS} FROM ${CALL_FROM} WHERE ${whereSql}
      ORDER BY ${sortCol} ${dir} NULLS LAST, m.created_at DESC
      LIMIT $${limIdx} OFFSET $${offIdx}`, params);
  return { calls: r.rows, total: Number(totalR.rows[0].n) };
}
```
And update `getCall` to `SELECT ${CALL_COLS} FROM ${CALL_FROM} WHERE m.tenant_id = $1 AND m.id = $2 AND m.role = 'inbound'`.
(`sortCol`/`dir` come only from the allow-list / a literal — never from raw user text.)

- [ ] **Step 5: Run, confirm PASS** (new tests + existing repo tests in the file).

- [ ] **Step 6: Commit**
```bash
git add server/src/repos/callAnalytics.ts server/test/callAnalytics.repo.test.ts
git commit -m "feat(calls): listCalls exposes call_facts columns + filters + sort (allow-listed)"
```

---

## Task 2: `callAnalyticsSummary`

**Files:** Modify `server/src/repos/callAnalytics.ts`; Test `server/test/callAnalytics.summary.test.ts` (new)

- [ ] **Step 1: Write the failing test** `server/test/callAnalytics.summary.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { callAnalyticsSummary } from '../src/repos/callAnalytics.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function seed(tenantId: string, f: { resolution?: string; fcr?: boolean; callback?: boolean; escalation?: boolean; sentiment?: string; duration?: number }) {
  const th = await pool.query<{ id: string }>(`INSERT INTO agent_threads (tenant_id, jobix_thread_ref) VALUES ($1,'jobix:'||gen_random_uuid()) RETURNING id`, [tenantId]);
  const m = await pool.query<{ id: string }>(`INSERT INTO agent_messages (thread_id, tenant_id, role, source, content, status) VALUES ($1,$2,'inbound','jobix','x','sent') RETURNING id`, [th.rows[0].id, tenantId]);
  await pool.query(`INSERT INTO call_facts (tenant_id, message_id, resolution_state, fcr, callback_requested, escalation_requested, sentiment, call_duration_seconds)
    VALUES ($1,$2,COALESCE($3,'open'),$4,$5,$6,$7,$8)`,
    [tenantId, m.rows[0].id, f.resolution ?? null, f.fcr ?? null, f.callback ?? false, f.escalation ?? false, f.sentiment ?? null, f.duration ?? null]);
}

describe('callAnalyticsSummary', () => {
  it('computes totals, resolution rate, fcr, callback, escalation, avg duration, sentiment mix', async () => {
    const t = await createTenant(pool);
    await seed(t.id, { resolution: 'resolved', fcr: true, sentiment: 'positive', duration: 120 });
    await seed(t.id, { resolution: 'open', callback: true, sentiment: 'negative', duration: 60 });
    await seed(t.id, { resolution: 'resolved', escalation: true, sentiment: null, duration: null });
    const s = await callAnalyticsSummary(pool, t.id, new Date('2000-01-01'), new Date('2999-01-01'));
    expect(s.total).toBe(3);
    expect(s.resolved).toBe(2);
    expect(s.resolutionRatePct).toBe(67);
    expect(s.fcrCount).toBe(1);
    expect(s.callbackCount).toBe(1);
    expect(s.escalationCount).toBe(1);
    expect(s.avgDurationSeconds).toBe(90); // avg of 120,60 (nulls ignored)
    expect(s.sentimentMix).toEqual({ positive: 1, neutral: 0, negative: 1, unknown: 1 });
  });
});
```

- [ ] **Step 2: Run, confirm FAIL.**

- [ ] **Step 3: Implement** (append to `callAnalytics.ts`):
```ts
export interface CallSummary {
  total: number; resolved: number; resolutionRatePct: number;
  fcrCount: number; callbackCount: number; escalationCount: number; avgDurationSeconds: number;
  sentimentMix: { positive: number; neutral: number; negative: number; unknown: number };
}
export async function callAnalyticsSummary(pool: pg.Pool, tenantId: string, start: Date, end: Date): Promise<CallSummary> {
  const r = await pool.query<Record<string, string>>(
    `SELECT count(*)::text total,
            count(*) FILTER (WHERE f.resolution_state = 'resolved')::text resolved,
            count(*) FILTER (WHERE f.fcr IS TRUE)::text fcr,
            count(*) FILTER (WHERE f.callback_requested IS TRUE)::text callback,
            count(*) FILTER (WHERE f.escalation_requested IS TRUE)::text escalation,
            COALESCE(round(avg(f.call_duration_seconds))::int, 0)::text avg_duration,
            count(*) FILTER (WHERE f.sentiment = 'positive')::text s_pos,
            count(*) FILTER (WHERE f.sentiment = 'neutral')::text s_neu,
            count(*) FILTER (WHERE f.sentiment = 'negative')::text s_neg,
            count(*) FILTER (WHERE f.sentiment IS NULL)::text s_unk
       FROM agent_messages m LEFT JOIN call_facts f ON f.message_id = m.id
      WHERE m.tenant_id = $1 AND m.role = 'inbound' AND m.created_at >= $2 AND m.created_at < $3`,
    [tenantId, start, end]);
  const x = r.rows[0]; const total = Number(x.total); const resolved = Number(x.resolved);
  return {
    total, resolved,
    resolutionRatePct: total ? Math.round((resolved / total) * 100) : 0,
    fcrCount: Number(x.fcr), callbackCount: Number(x.callback), escalationCount: Number(x.escalation),
    avgDurationSeconds: Number(x.avg_duration),
    sentimentMix: { positive: Number(x.s_pos), neutral: Number(x.s_neu), negative: Number(x.s_neg), unknown: Number(x.s_unk) },
  };
}
```

- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Commit**
```bash
git add server/src/repos/callAnalytics.ts server/test/callAnalytics.summary.test.ts
git commit -m "feat(calls): callAnalyticsSummary (resolution/fcr/callback/escalation/duration/sentiment)"
```

---

## Task 3: `breakdownBy` + `crosstabDeptCategory`

**Files:** Modify `server/src/repos/callAnalytics.ts`; Test `server/test/callAnalytics.breakdown.test.ts` (new)

- [ ] **Step 1: Write the failing test** `server/test/callAnalytics.breakdown.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { breakdownBy, crosstabDeptCategory } from '../src/repos/callAnalytics.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function seed(tenantId: string, attribution: string | null, category: string | null) {
  const th = await pool.query<{ id: string }>(`INSERT INTO agent_threads (tenant_id, jobix_thread_ref) VALUES ($1,'jobix:'||gen_random_uuid()) RETURNING id`, [tenantId]);
  const m = await pool.query<{ id: string }>(`INSERT INTO agent_messages (thread_id, tenant_id, role, source, content, status) VALUES ($1,$2,'inbound','jobix','x','sent') RETURNING id`, [th.rows[0].id, tenantId]);
  await pool.query(`INSERT INTO call_facts (tenant_id, message_id, attribution_label) VALUES ($1,$2,$3)`, [tenantId, m.rows[0].id, attribution]);
  if (category) await pool.query(`INSERT INTO line_call_tags (tenant_id, message_id, category, severity) VALUES ($1,$2,$3,'low')`, [tenantId, m.rows[0].id, category]);
}
const W = [new Date('2000-01-01'), new Date('2999-01-01')] as const;

describe('breakdownBy + crosstab', () => {
  it('groups by an allow-listed dimension and rejects others', async () => {
    const t = await createTenant(pool);
    await seed(t.id, 'Accounts', 'Arrears'); await seed(t.id, 'Accounts', 'Arrears'); await seed(t.id, 'Maintenance', 'Leak');
    const byDept = await breakdownBy(pool, t.id, 'attribution_label', W[0], W[1]);
    expect(byDept).toEqual([{ key: 'Accounts', count: 2 }, { key: 'Maintenance', count: 1 }]);
    await expect(breakdownBy(pool, t.id, 'evil_col' as never, W[0], W[1])).rejects.toThrow();
  });
  it('crosstab returns dept x category counts', async () => {
    const t = await createTenant(pool);
    await seed(t.id, 'Accounts', 'Arrears'); await seed(t.id, 'Accounts', 'Arrears'); await seed(t.id, 'Maintenance', 'Leak');
    const x = await crosstabDeptCategory(pool, t.id, W[0], W[1]);
    expect(x).toContainEqual({ attribution_label: 'Accounts', category: 'Arrears', count: 2 });
    expect(x).toContainEqual({ attribution_label: 'Maintenance', category: 'Leak', count: 1 });
  });
});
```

- [ ] **Step 2: Run, confirm FAIL.**

- [ ] **Step 3: Implement** (append to `callAnalytics.ts`; reuses `BREAKDOWN_COLUMNS` from Task 1):
```ts
export async function breakdownBy(pool: pg.Pool, tenantId: string, dimension: string, start: Date, end: Date): Promise<Array<{ key: string | null; count: number }>> {
  const col = BREAKDOWN_COLUMNS[dimension];
  if (!col) throw new Error(`invalid breakdown dimension: ${dimension}`);
  const r = await pool.query<{ key: string | null; count: string }>(
    `SELECT ${col} AS key, count(*)::text count
       FROM agent_messages m
       LEFT JOIN call_facts f     ON f.message_id = m.id
       LEFT JOIN line_call_tags t ON t.message_id = m.id
      WHERE m.tenant_id = $1 AND m.role = 'inbound' AND m.created_at >= $2 AND m.created_at < $3
      GROUP BY 1 ORDER BY count(*) DESC`, [tenantId, start, end]);
  return r.rows.map(x => ({ key: x.key, count: Number(x.count) }));
}

export async function crosstabDeptCategory(pool: pg.Pool, tenantId: string, start: Date, end: Date): Promise<Array<{ attribution_label: string | null; category: string | null; count: number }>> {
  const r = await pool.query<{ attribution_label: string | null; category: string | null; count: string }>(
    `SELECT f.attribution_label, t.category, count(*)::text count
       FROM agent_messages m
       LEFT JOIN call_facts f     ON f.message_id = m.id
       LEFT JOIN line_call_tags t ON t.message_id = m.id
      WHERE m.tenant_id = $1 AND m.role = 'inbound' AND m.created_at >= $2 AND m.created_at < $3
      GROUP BY 1, 2 ORDER BY count(*) DESC`, [tenantId, start, end]);
  return r.rows.map(x => ({ attribution_label: x.attribution_label, category: x.category, count: Number(x.count) }));
}
```

- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Commit**
```bash
git add server/src/repos/callAnalytics.ts server/test/callAnalytics.breakdown.test.ts
git commit -m "feat(calls): breakdownBy (allow-listed dimension) + crosstabDeptCategory"
```

---

## Task 4: Routes — filters/sort on `/api/calls`, expanded `/api/calls/breakdown`, widened `/api/calls/:id`

**Files:** Modify `server/src/routes/callAnalytics.ts`; Test `server/test/callAnalytics.routes.test.ts` (extend)

- [ ] **Step 1: Read** `server/src/routes/callAnalytics.ts` (scoped) — note how `/api/calls` parses query, how `/api/calls/breakdown` resolves its today/7d/30d window, the role-gate helper, and the existing test file's auth setup.

- [ ] **Step 2: Write failing tests** (extend `server/test/callAnalytics.routes.test.ts`, matching its existing auth/session setup): one asserting `GET /api/calls?attribution=Accounts&sort=attribution_label&sortDir=asc` filters+sorts; one asserting `GET /api/calls/breakdown?window=7d` returns keys `summary, byCategory, byDepartment, byOutcome, bySentiment, byResolution, crosstab, perDay`; one asserting an admin-only gate (non-admin → 401/403) still holds; one asserting `sort=bogus` → 400. (Use the file's existing helper to seed an inbound call with facts, or inline the `seedCall` helper from Task 1.)

- [ ] **Step 3: Implement.** In `/api/calls`, parse the new optional query params with zod and pass to `listCalls`:
```ts
const Q = z.object({
  category: z.string().optional(), search: z.string().optional(),
  from: z.coerce.date().optional(), to: z.coerce.date().optional(),
  limit: z.coerce.number().optional(), offset: z.coerce.number().optional(),
  attribution: z.string().optional(), outcome: z.string().optional(),
  sentiment: z.string().optional(), resolution: z.string().optional(),
  callbackRequested: z.coerce.boolean().optional(), escalationRequested: z.coerce.boolean().optional(),
  sort: z.enum(['created_at','attribution_label','category','call_outcome','sentiment','call_duration_seconds','resolution_state']).optional(),
  sortDir: z.enum(['asc','desc']).optional(),
}).parse(req.query);
```
(invalid `sort` → zod throws → existing `sendError` returns 400). Add an expanded `/api/calls/breakdown` handler that, after resolving `start`/`end` from the `window` exactly as the current route does, returns:
```ts
const [summary, byCategory, byDepartment, byOutcome, bySentiment, byResolution, crosstab, perDay] = await Promise.all([
  callAnalyticsSummary(app.pool, tenantId, start, end),
  breakdownBy(app.pool, tenantId, 'category', start, end),
  breakdownBy(app.pool, tenantId, 'attribution_label', start, end),
  breakdownBy(app.pool, tenantId, 'call_outcome', start, end),
  breakdownBy(app.pool, tenantId, 'sentiment', start, end),
  breakdownBy(app.pool, tenantId, 'resolution_state', start, end),
  crosstabDeptCategory(app.pool, tenantId, start, end),
  callsPerDay(app.pool, tenantId, start, end),
]);
return reply.send({ summary, byCategory, byDepartment, byOutcome, bySentiment, byResolution, crosstab, perDay });
```
Import the new repo functions. Keep `byCategory` + `perDay` shaped as today so existing UI keeps working mid-migration. The widened `getCall` already flows through `/api/calls/:id`. Keep the same role gate on every route.

- [ ] **Step 4: Run, confirm PASS** (new + existing route tests):
  `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism test/callAnalytics.routes.test.ts`

- [ ] **Step 5: Commit**
```bash
git add server/src/routes/callAnalytics.ts server/test/callAnalytics.routes.test.ts
git commit -m "feat(calls): /api/calls filters+sort; /api/calls/breakdown multi-dimension"
```

---

## Task 5: `GET /api/calls/export.csv`

**Files:** Modify `server/src/routes/callAnalytics.ts`; Test `server/test/callAnalytics.export.test.ts` (new)

- [ ] **Step 1: Write the failing test** `server/test/callAnalytics.export.test.ts` (mirror the route test's app/auth setup; seed 2 inbound calls with facts). Assert: authed `GET /api/calls/export.csv?attribution=Accounts` returns 200, `content-type` includes `text/csv`, a `content-disposition: attachment` header, a header row containing `Time,Caller,Phone,Department,Type,Category,Outcome,Sentiment,Duration,Callback,Escalation,Resolution,Summary`, and exactly one data row (the Accounts call). Assert non-admin → 401/403.

- [ ] **Step 2: Run, confirm FAIL** (route 404).

- [ ] **Step 3: Implement** a new route. Reuse `listCalls` with the same zod query parsing as `/api/calls` but force `limit: 5000, offset: 0`. Build CSV in-process:
```ts
function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
// header + rows
const header = ['Time','Caller','Phone','Department','Type','Category','Outcome','Sentiment','Duration','Callback','Escalation','Resolution','Summary'];
const lines = [header.join(',')];
for (const c of calls) lines.push([
  c.created_at instanceof Date ? c.created_at.toISOString() : String(c.created_at),
  c.caller_name, c.caller_phone, c.attribution_label, c.call_type, c.category,
  c.call_outcome, c.sentiment, c.call_duration_seconds,
  c.callback_requested ? 'yes' : '', c.escalation_requested ? 'yes' : '',
  c.resolution_state, (c.content ?? '').replace(/\s+/g, ' ').slice(0, 500),
].map(csvCell).join(','));
reply.header('content-type', 'text/csv; charset=utf-8');
reply.header('content-disposition', 'attachment; filename="calls.csv"');
return reply.send(lines.join('\n'));
```
Cap at 5000 (the `listCalls` limit clamps to 200 — so for export, call a dedicated query path: either raise the clamp via a separate exported `listCallsForExport` that allows up to 5000, OR loop pages). Implement `listCallsForExport(pool, tenantId, opts)` in the repo: same query as `listCalls` but `limit` clamped to `Math.min(opts.limit ?? 5000, 5000)` and no `total` count. Use it here. Same role gate.

- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Commit**
```bash
git add server/src/repos/callAnalytics.ts server/src/routes/callAnalytics.ts server/test/callAnalytics.export.test.ts
git commit -m "feat(calls): GET /api/calls/export.csv (filtered, capped 5000)"
```

---

## Task 6: Scope-parity + non-breakage test

**Files:** Test `server/test/callAnalytics.parity.test.ts` (new)

- [ ] **Step 1: Write the test.** Seed for one tenant: a webhook call (inbound jobix + a `call_facts` row) and a legacy mirror call (inbound jobix, NO `call_facts` row — insert just the `agent_messages` row). Assert `listCalls(pool, t.id, {})` returns BOTH (total 2), the legacy row has `attribution_label === null` but still appears, and `callAnalyticsSummary` counts both in `total`. This proves the LEFT JOIN preserves the full call set (no row dropped by requiring facts).
```ts
// (reuse makePool/truncateAll/createTenant; insert agent_messages directly for the legacy row)
```

- [ ] **Step 2: Run, confirm PASS** (should pass against the Task 1–3 implementation).
- [ ] **Step 3: Commit**
```bash
git add server/test/callAnalytics.parity.test.ts
git commit -m "test(calls): scope parity — calls without facts still listed/aggregated"
```

---

## Task 7: Web API client — types + calls for new fields/filters/breakdown/export

**Files:** Modify the web API module the Calls page uses (find it: `web/src/api/*` or inline `fetch` in `web/src/pages/Calls.tsx`); no test harness for web — verify with `npm -w web run build`.

- [ ] **Step 1: Read** `web/src/pages/Calls.tsx` (scoped) to see how it currently calls `/api/calls`, `/api/calls/breakdown`, `/api/calls/:id` (fetch wrapper? a typed client?). Match that pattern.

- [ ] **Step 2: Implement** TypeScript types + fetch functions mirroring the new backend shapes:
  - `CallRow` type with the new fields (caller_name, caller_phone, attribution_label, call_type, call_outcome, sentiment, call_duration_seconds, callback_requested, escalation_requested, resolution_state).
  - `listCalls(params)` accepting the new filter/sort params, building a query string.
  - `getBreakdown(window)` returning `{ summary, byCategory, byDepartment, byOutcome, bySentiment, byResolution, crosstab, perDay }` with typed shapes (summary fields per Task 2; breakdown arrays `{ key: string|null, count: number }`; crosstab `{ attribution_label, category, count }`).
  - `exportCallsCsvUrl(params)` returning the `/api/calls/export.csv?...` URL (the button triggers a download via `window.location`/anchor).
  Follow the codebase's existing auth/credentials convention (cookies/session are already handled by the existing calls).

- [ ] **Step 3: Verify build:** `npm -w web run build` → passes (tsc + vite).
- [ ] **Step 4: Commit**
```bash
git add web/src
git commit -m "feat(calls-ui): web client types/calls for structured calls, breakdown, csv export"
```

---

## Task 8: ExplorerPanel → Excel-style grid

**Files:** Modify `web/src/pages/Calls.tsx` (the `ExplorerPanel` component, ~lines 486–698).

- [ ] **Step 1: Read** the current `ExplorerPanel` + `SeverityChip` (scoped) to match styling/state patterns.
- [ ] **Step 2: Implement:**
  - Desktop table columns: **Time, Caller (name + phone under it), Department (attribution_label), Type, Category, Outcome, Sentiment (chip), Duration (mm:ss via a small `fmtDuration`), Callback (✓/—), Escalation (✓/—), Resolution (chip), Excerpt**. Wrap in a horizontally-scrollable container. Mobile cards keep Time, Department, Category, Outcome, Resolution, Excerpt.
  - **Sortable headers:** clicking Time / Department / Category / Outcome / Sentiment / Duration / Resolution sets `sort`+`sortDir` (toggle dir; show ▲/▼). Pass to `listCalls`.
  - **Filters row:** keep search + category + date range; add dropdowns for Department, Outcome, Sentiment, Resolution (options can be sourced from the breakdown response keys or be free-typed), and Callback/Escalation toggles. Changing any resets to page 0 and refetches.
  - **Export CSV** button near the filters → navigates to `exportCallsCsvUrl(currentParams)` (anchor with `download`).
  - Null fields render as "—"; sentiment/resolution use small colored chips (reuse `SeverityChip` style; add `SentimentChip`/`ResolutionChip` tiny helpers in the same file).
  - Row click still opens the detail modal (Task 10).
- [ ] **Step 3: Verify build:** `npm -w web run build` passes. Manually sanity-check by reading the diff for column/filter wiring.
- [ ] **Step 4: Commit**
```bash
git add web/src/pages/Calls.tsx
git commit -m "feat(calls-ui): Excel-style call grid (structured columns, sort, filters, CSV)"
```

---

## Task 9: BreakdownPanel → multi-dimension dashboard

**Files:** Modify `web/src/pages/Calls.tsx` (the `BreakdownPanel` component, ~lines 214–339).

- [ ] **Step 1: Read** the current `BreakdownPanel` (scoped) — note its bar-row rendering and window toggle.
- [ ] **Step 2: Implement**, consuming the expanded `/api/calls/breakdown`:
  - **Metric cards row:** Total calls, Resolution rate %, FCR count, Callbacks, Escalations, Avg duration (mm:ss). From `summary`.
  - **Headline "Who & why":** a department×category view from `crosstab` — render as grouped rows (Department → its categories with counts) or a compact stacked-bar; keep it readable, reuse the existing bar component.
  - **Mini-breakdowns** (reuse the existing ranked-bar list component): by Department (`byDepartment`), by Outcome (`byOutcome`), by Sentiment (`bySentiment`), by Resolution (`byResolution`). NULL `key` renders as "Unattributed"/"Uncategorised"/"Unknown".
  - Keep the existing per-day trend (`perDay`) and the Today/7d/30d window toggle (drives the same `window` param).
  - Empty/zero state: show the existing empty message when `summary.total === 0`.
- [ ] **Step 3: Verify build:** `npm -w web run build` passes.
- [ ] **Step 4: Commit**
```bash
git add web/src/pages/Calls.tsx
git commit -m "feat(calls-ui): multi-dimension dashboard (who&why crosstab, metric cards, mixes)"
```

---

## Task 10: Read-only drill-down modal

**Files:** Modify `web/src/pages/Calls.tsx` (the call detail modal opened from `ExplorerPanel`).

- [ ] **Step 1: Read** the current detail modal markup (scoped).
- [ ] **Step 2: Implement:** expand the modal to show the structured record (read-only): a **Caller** block (name, phone), **Department/Type**, **Outcome**, **Sentiment**, **Duration**, **Callback** (+preferred time if present), **Escalation**, **Resolution state**, **Category/Severity**, then the full summary text in the existing scrollable `<pre>`, then `call_values` as a small key/value list if present (fetch via `getCall` which now returns the structured row; if `call_values` isn't on `getCall`'s row, show what's available — do NOT add new backend fields in Slice A). No edit controls.
- [ ] **Step 3: Verify build:** `npm -w web run build` passes.
- [ ] **Step 4: Commit**
```bash
git add web/src/pages/Calls.tsx
git commit -m "feat(calls-ui): read-only structured drill-down modal"
```

> NOTE: `getCall` (Task 1) returns the `CallRow` columns, which do NOT include `call_values`. If the drill-down should show `call_values`, that is a one-line backend addition — but it is OUT OF SCOPE for Slice A per the spec (the modal shows the `CallRow` fields). Render only what `getCall` returns.

---

## Task 11: Full suite + strict builds (non-breakage gate)

**Files:** none (verification only)

- [ ] **Step 1: Full backend suite (serial):**
  `TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism`
  Expected: ALL green — especially existing `callAnalytics.*`, `lineReport.*`, `handover.*`, and email tests. No regressions.
- [ ] **Step 2: Strict backend build:** `npm -w server run build` → tsc zero errors.
- [ ] **Step 3: Web build:** `npm -w web run build` → passes.
- [ ] **Step 4:** If anything fails, use superpowers:systematic-debugging; fix minimally without weakening tests; re-run. Commit any fix:
```bash
git add -A && git commit -m "fix(calls): address full-suite/build issues from analytics center"
```

---

## Done criteria
- `/api/calls` filters + sorts on the structured dimensions; `/api/calls/breakdown` returns summary + 5 breakdowns + crosstab + perDay; `/api/calls/export.csv` downloads the filtered grid.
- Calls page shows the multi-dimension dashboard + Excel-style grid + read-only structured drill-down.
- Scope parity proven (calls without facts still listed/aggregated); full backend suite green; strict `tsc` + web build pass; handovers/send pipeline untouched; role gating unchanged.

## Out of scope (Slice B)
- `call_actions` (tasks/forward/outbound comms/resolution disposition), cross-call worklist, surfacing handovers in a unified view, editing resolution_state, Abe chat tools for new dimensions, saved views/column prefs.
