# Agentic Call DB — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a call a first-class record — `call_facts` (structured outcome + attribution + caller identity, fed by a new Jobix webhook) joined to `agent_messages` via a `calls` view — without touching any existing email flow.

**Architecture:** Strictly additive. New migration (`call_facts` + `calls` view + `attribution_map` column), new pure payload parser, a new ingest orchestrator that reuses the existing idempotent thread/message insert pattern, a new API-key-authed `POST /v1/jobix/calls` route, and an extension to the existing backfill. The send pipeline, `mirrorCall.ts`, templates, and email events are not modified.

**Tech Stack:** Node + TypeScript (ESM, `.js` import specifiers), Fastify, Zod, node-pg (raw SQL), node-pg-migrate (`.cjs`), Vitest (serial, against the Neon test branch).

**Spec:** `docs/superpowers/specs/2026-06-05-agentic-call-db-design.md`

**Conventions to follow (verified in repo):**
- Repos are plain functions taking `pool` first, raw SQL, typed row interfaces (see `server/src/repos/lineCallTags.ts`).
- Tests use `makePool`/`truncateAll` from `./helpers/db.js` and `createTenant` from `./helpers/factories.js`; route tests `buildApp({ cfg })` + `app.inject`; API keys via `insertApiKey` + `generateApiKey`/`hashApiKey`/`prefixOf` (see `server/test/v1Emails.test.ts`).
- Run a single test file: `npm -w server run test -- <relativePathFromServer>` (vitest). Full suite is serial.
- **Before any push:** `npm -w server run build` (strict `tsc` — vitest/tsx does not typecheck).

---

## Task 1: Migration — `call_facts`, `calls` view, `attribution_map`

**Files:**
- Create: `server/migrations/1700000000030_call_facts.cjs`

- [ ] **Step 1: Write the migration**

```js
/* eslint-disable camelcase */
// Agentic call DB foundation: a first-class structured record per inbound call,
// 1:1 with the human-readable agent_messages row, plus a `calls` view that joins
// message + facts + tags. Additive only — no existing table is altered destructively.
exports.up = (pgm) => {
  pgm.createTable('call_facts', {
    id:                      { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:               { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    message_id:              { type: 'uuid', notNull: true, references: 'agent_messages(id)', onDelete: 'CASCADE' },
    caller_suid:             { type: 'text' },
    caller_name:             { type: 'text' },
    caller_phone:            { type: 'text' },
    caller_timezone:         { type: 'text' },
    line_ref:                { type: 'text' },
    attribution_label:       { type: 'text' },
    call_type:               { type: 'text' },
    summary:                 { type: 'text' },
    call_outcome:            { type: 'text' },
    sentiment:               { type: 'text' },
    call_duration_seconds:   { type: 'integer' },
    callback_requested:      { type: 'boolean', notNull: true, default: false },
    callback_preferred_time: { type: 'text' },
    escalation_requested:    { type: 'boolean', notNull: true, default: false },
    resolution_state:        { type: 'text', notNull: true, default: 'open',
                               check: "resolution_state IN ('open','in_progress','resolved','unresolved')" },
    resolved_at:             { type: 'timestamptz' },
    resolved_by:             { type: 'uuid', references: 'users(id)', onDelete: 'SET NULL' },
    fcr:                     { type: 'boolean' },
    values:                  { type: 'jsonb', notNull: true, default: '{}' },
    raw_payload:             { type: 'jsonb', notNull: true, default: '{}' },
    created_at:              { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at:              { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('call_facts', 'call_facts_message_uniq', { unique: ['message_id'] });
  pgm.createIndex('call_facts', ['tenant_id', { name: 'created_at', sort: 'DESC' }]);
  pgm.createIndex('call_facts', ['tenant_id', 'attribution_label']);
  pgm.createIndex('call_facts', ['tenant_id', 'resolution_state']);
  pgm.createIndex('call_facts', ['tenant_id', 'caller_suid']);

  // Per-tenant rule for resolving the "who"/type out of the free-form values payload.
  pgm.addColumn('line_report_configs', {
    attribution_map: { type: 'jsonb', notNull: true, default: '{}' },
  });

  pgm.createView('calls', {}, `
    SELECT m.id AS message_id, m.tenant_id, m.content AS summary_text, m.created_at,
           f.caller_suid, f.caller_name, f.caller_phone,
           f.line_ref, f.attribution_label, f.call_type, f.call_outcome, f.sentiment,
           f.call_duration_seconds, f.callback_requested, f.escalation_requested,
           f.resolution_state, f.fcr, f.values,
           t.category, t.severity
      FROM agent_messages m
      LEFT JOIN call_facts f     ON f.message_id = m.id
      LEFT JOIN line_call_tags t ON t.message_id = m.id
     WHERE m.role = 'inbound' AND m.source = 'jobix'
  `);
};

exports.down = (pgm) => {
  pgm.dropView('calls');
  pgm.dropColumn('line_report_configs', 'attribution_map');
  pgm.dropTable('call_facts');
};
```

- [ ] **Step 2: Run the migration against the test branch**

Run: `npm -w server run migrate:up` (or the repo's migrate script; check `server/package.json` scripts — use the one the other migrations use)
Expected: migration `1700000000030_call_facts` applied, no error.

- [ ] **Step 3: Commit**

```bash
git add server/migrations/1700000000030_call_facts.cjs
git commit -m "feat(calls): call_facts table + calls view + attribution_map column"
```

---

## Task 2: Pure payload parser — duration

**Files:**
- Create: `server/src/agent/abe/jobixPayload.ts`
- Test: `server/test/jobixPayload.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { parseDurationSeconds } from '../src/agent/abe/jobixPayload.js';

describe('parseDurationSeconds', () => {
  it('parses "3 minutes 42 seconds" to 222', () => {
    expect(parseDurationSeconds('3 minutes 42 seconds')).toBe(222);
  });
  it('parses minutes-only and seconds-only', () => {
    expect(parseDurationSeconds('5 minutes')).toBe(300);
    expect(parseDurationSeconds('45 seconds')).toBe(45);
  });
  it('returns null for missing/garbage', () => {
    expect(parseDurationSeconds(undefined)).toBeNull();
    expect(parseDurationSeconds('')).toBeNull();
    expect(parseDurationSeconds('soon')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w server run test -- test/jobixPayload.test.ts`
Expected: FAIL — `parseDurationSeconds` is not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// Pure helpers for normalizing a Jobix post-call payload. No DB, no IO.

// "3 minutes 42 seconds" -> 222. Accepts minutes-only / seconds-only. null if unparseable.
export function parseDurationSeconds(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const m = raw.match(/(\d+)\s*min/i);
  const s = raw.match(/(\d+)\s*sec/i);
  if (!m && !s) return null;
  return (m ? Number(m[1]) * 60 : 0) + (s ? Number(s[1]) : 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w server run test -- test/jobixPayload.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/agent/abe/jobixPayload.ts server/test/jobixPayload.test.ts
git commit -m "feat(calls): parseDurationSeconds for Jobix call duration"
```

---

## Task 3: Pure payload parser — normalize a call

**Files:**
- Modify: `server/src/agent/abe/jobixPayload.ts`
- Test: `server/test/jobixPayload.test.ts` (add cases)

The webhook body is the post-call payload. Two shapes occur in the wild: a flat shape
(`{ suid, call_summary, call_outcome, ... }`) and the customer-save shape
(`{ company_key, customer_data: { main, values } }`). `normalizeCall` accepts the raw body plus
the tenant's `attribution_map` and returns a flat normalized object ready for `call_facts`.

- [ ] **Step 1: Write the failing test (append to the file)**

```ts
import { normalizeCall } from '../src/agent/abe/jobixPayload.js';

describe('normalizeCall', () => {
  it('extracts caller identity + outcome from customer_data shape', () => {
    const body = {
      company_key: 'V7E-...',
      customer_data: {
        main: { suid: 's1', name: 'Renier Jacobs', phone: '+27609381283', timezone: 'Africa/Johannesburg' },
        values: { type: 'Seller', call_summary: 'wants to sell', call_outcome: 'completed', sentiment: 'positive' },
      },
    };
    const n = normalizeCall(body, {});
    expect(n.callerSuid).toBe('s1');
    expect(n.callerName).toBe('Renier Jacobs');
    expect(n.callerPhone).toBe('+27609381283');
    expect(n.callerTimezone).toBe('Africa/Johannesburg');
    expect(n.summary).toBe('wants to sell');
    expect(n.callOutcome).toBe('completed');
    expect(n.sentiment).toBe('positive');
    expect(n.values).toEqual(body.customer_data.values);
  });

  it('handles the flat shape and parses duration + flags', () => {
    const body = {
      suid: 's2', call_summary: 'test drive', call_outcome: 'completed',
      callback_requested: true, callback_preferred_time: '15 April 2026',
      escalation_requested: false, call_duration: '3 minutes 42 seconds',
    };
    const n = normalizeCall(body, {});
    expect(n.callerSuid).toBe('s2');
    expect(n.summary).toBe('test drive');
    expect(n.callbackRequested).toBe(true);
    expect(n.callbackPreferredTime).toBe('15 April 2026');
    expect(n.escalationRequested).toBe(false);
    expect(n.callDurationSeconds).toBe(222);
  });

  it('resolves attribution via attribution_map values_key', () => {
    const body = { customer_data: { main: { suid: 's3' }, values: { department: 'Maintenance' } } };
    const n = normalizeCall(body, { source: 'values_key', values_key: 'department' });
    expect(n.attributionLabel).toBe('Maintenance');
  });

  it('default attribution heuristic falls back through type/Call/call/context/call_purpose', () => {
    const body = { customer_data: { main: { suid: 's4' }, values: { context: 'abandoned deposit' } } };
    const n = normalizeCall(body, {});
    expect(n.attributionLabel).toBe('abandoned deposit');
    expect(n.callType).toBe('abandoned deposit');
  });

  it('missing fields are null, never throws', () => {
    const n = normalizeCall({}, {});
    expect(n.callerSuid).toBeNull();
    expect(n.summary).toBeNull();
    expect(n.callbackRequested).toBe(false);
    expect(n.values).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w server run test -- test/jobixPayload.test.ts`
Expected: FAIL — `normalizeCall` not exported.

- [ ] **Step 3: Write minimal implementation (append to `jobixPayload.ts`)**

```ts
export interface AttributionMap { source?: 'agent' | 'values_key'; values_key?: string }

export interface NormalizedCall {
  callerSuid: string | null; callerName: string | null;
  callerPhone: string | null; callerTimezone: string | null;
  lineRef: string | null; attributionLabel: string | null; callType: string | null;
  summary: string | null; callOutcome: string | null; sentiment: string | null;
  callDurationSeconds: number | null;
  callbackRequested: boolean; callbackPreferredTime: string | null;
  escalationRequested: boolean;
  values: Record<string, unknown>;
}

const str = (v: unknown): string | null =>
  (typeof v === 'string' && v.trim()) ? v.trim() : (typeof v === 'number' ? String(v) : null);
const bool = (v: unknown): boolean => v === true || v === 'true' || v === 'yes';

const TYPE_KEYS = ['type', 'Call', 'call', 'context', 'call_purpose'];

// Pick the call-type / attribution label out of the values bag.
function pickType(values: Record<string, unknown>): string | null {
  for (const k of TYPE_KEYS) { const v = str(values[k]); if (v) return v; }
  return null;
}

export function normalizeCall(body: unknown, attribution: AttributionMap, lineRef?: string | null): NormalizedCall {
  const b = (body ?? {}) as Record<string, unknown>;
  const cd = (b.customer_data ?? {}) as Record<string, unknown>;
  const main = (cd.main ?? {}) as Record<string, unknown>;
  const values = ((cd.values ?? {}) as Record<string, unknown>) ?? {};

  // suid/summary may live in main, values, or at the top level (flat shape).
  const callerSuid = str(main.suid) ?? str(b.suid) ?? str(values.suid);
  const summary    = str(values.call_summary) ?? str(values.summary) ?? str(b.call_summary) ?? str(b.summary);
  const get = (k: string): unknown => values[k] ?? b[k];

  const callType = pickType(values);
  let attributionLabel: string | null;
  if (attribution.source === 'agent') attributionLabel = lineRef ?? null;
  else if (attribution.source === 'values_key' && attribution.values_key)
    attributionLabel = str(values[attribution.values_key]);
  else attributionLabel = callType; // default heuristic

  return {
    callerSuid,
    callerName: str(main.name) ?? str(b.name) ?? str(values.full_name) ?? str(values.first_name),
    callerPhone: str(main.phone) ?? str(b.phone) ?? str(values.phone_number) ?? str(values.cell_number),
    callerTimezone: str(main.timezone) ?? str(b.timezone),
    lineRef: lineRef ?? null,
    attributionLabel,
    callType,
    summary,
    callOutcome: str(get('call_outcome')),
    sentiment: str(get('sentiment')),
    callDurationSeconds: parseDurationSeconds(get('call_duration')),
    callbackRequested: bool(get('callback_requested')),
    callbackPreferredTime: str(get('callback_preferred_time')) ?? str(get('callback_time')),
    escalationRequested: bool(get('escalation_requested')),
    values,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w server run test -- test/jobixPayload.test.ts`
Expected: PASS (all `parseDurationSeconds` + `normalizeCall` cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/agent/abe/jobixPayload.ts server/test/jobixPayload.test.ts
git commit -m "feat(calls): normalizeCall — map Jobix payload to call_facts fields"
```

---

## Task 4: `call_facts` repo — upsert + read

**Files:**
- Create: `server/src/repos/callFacts.ts`
- Test: `server/test/callFacts.repo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { upsertCallFacts, getCallFactsByMessage } from '../src/repos/callFacts.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

// Minimal inbound message so the FK + unique(message_id) are real.
async function seedMessage(tenantId: string): Promise<string> {
  const th = await pool.query<{ id: string }>(
    `INSERT INTO agent_threads (tenant_id, jobix_thread_ref) VALUES ($1,'jobix:s1') RETURNING id`, [tenantId]);
  const m = await pool.query<{ id: string }>(
    `INSERT INTO agent_messages (thread_id, tenant_id, role, source, content, status, message_ref)
     VALUES ($1,$2,'inbound','jobix','hi','sent','ref1') RETURNING id`, [th.rows[0].id, tenantId]);
  return m.rows[0].id;
}

const base = {
  callerSuid: 's1', callerName: 'R', callerPhone: '+27', callerTimezone: 'Africa/Johannesburg',
  lineRef: 'agentA', attributionLabel: 'Seller', callType: 'Seller', summary: 'hi',
  callOutcome: 'completed', sentiment: 'positive', callDurationSeconds: 222,
  callbackRequested: false, callbackPreferredTime: null, escalationRequested: false,
  values: { type: 'Seller' }, rawPayload: { ok: true },
};

describe('callFacts repo', () => {
  it('inserts then upserts on the same message (no duplicate)', async () => {
    const t = await createTenant(pool);
    const messageId = await seedMessage(t.id);

    await upsertCallFacts(pool, { tenantId: t.id, messageId, ...base });
    let f = await getCallFactsByMessage(pool, messageId);
    expect(f?.caller_suid).toBe('s1');
    expect(f?.call_duration_seconds).toBe(222);
    expect(f?.resolution_state).toBe('open');

    await upsertCallFacts(pool, { tenantId: t.id, messageId, ...base, summary: 'updated', callOutcome: 'escalated' });
    f = await getCallFactsByMessage(pool, messageId);
    expect(f?.summary).toBe('updated');
    expect(f?.call_outcome).toBe('escalated');

    const cnt = await pool.query(`SELECT COUNT(*)::int AS n FROM call_facts WHERE message_id=$1`, [messageId]);
    expect(cnt.rows[0].n).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w server run test -- test/callFacts.repo.test.ts`
Expected: FAIL — `callFacts.js` module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
import type pg from 'pg';
import type { NormalizedCall } from '../agent/abe/jobixPayload.js';

export interface CallFactsRow {
  id: string; tenant_id: string; message_id: string;
  caller_suid: string | null; caller_name: string | null;
  caller_phone: string | null; caller_timezone: string | null;
  line_ref: string | null; attribution_label: string | null; call_type: string | null;
  summary: string | null; call_outcome: string | null; sentiment: string | null;
  call_duration_seconds: number | null;
  callback_requested: boolean; callback_preferred_time: string | null;
  escalation_requested: boolean;
  resolution_state: 'open' | 'in_progress' | 'resolved' | 'unresolved';
  resolved_at: Date | null; resolved_by: string | null; fcr: boolean | null;
  values: Record<string, unknown>; raw_payload: Record<string, unknown>;
  created_at: Date; updated_at: Date;
}

export type CallFactsInput = NormalizedCall & {
  tenantId: string; messageId: string; rawPayload: Record<string, unknown>;
};

// Upsert on message_id (1:1 with the inbound call). Re-delivery updates, never duplicates.
export async function upsertCallFacts(pool: pg.Pool, a: CallFactsInput): Promise<void> {
  await pool.query(
    `INSERT INTO call_facts
       (tenant_id, message_id, caller_suid, caller_name, caller_phone, caller_timezone,
        line_ref, attribution_label, call_type, summary, call_outcome, sentiment,
        call_duration_seconds, callback_requested, callback_preferred_time, escalation_requested,
        values, raw_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (message_id) DO UPDATE SET
       caller_suid = EXCLUDED.caller_suid, caller_name = EXCLUDED.caller_name,
       caller_phone = EXCLUDED.caller_phone, caller_timezone = EXCLUDED.caller_timezone,
       line_ref = EXCLUDED.line_ref, attribution_label = EXCLUDED.attribution_label,
       call_type = EXCLUDED.call_type, summary = EXCLUDED.summary,
       call_outcome = EXCLUDED.call_outcome, sentiment = EXCLUDED.sentiment,
       call_duration_seconds = EXCLUDED.call_duration_seconds,
       callback_requested = EXCLUDED.callback_requested,
       callback_preferred_time = EXCLUDED.callback_preferred_time,
       escalation_requested = EXCLUDED.escalation_requested,
       values = EXCLUDED.values, raw_payload = EXCLUDED.raw_payload, updated_at = now()`,
    [a.tenantId, a.messageId, a.callerSuid, a.callerName, a.callerPhone, a.callerTimezone,
     a.lineRef, a.attributionLabel, a.callType, a.summary, a.callOutcome, a.sentiment,
     a.callDurationSeconds, a.callbackRequested, a.callbackPreferredTime, a.escalationRequested,
     JSON.stringify(a.values ?? {}), JSON.stringify(a.rawPayload ?? {})]);
}

export async function getCallFactsByMessage(pool: pg.Pool, messageId: string): Promise<CallFactsRow | null> {
  const r = await pool.query<CallFactsRow>(`SELECT * FROM call_facts WHERE message_id = $1`, [messageId]);
  return r.rows[0] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w server run test -- test/callFacts.repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/repos/callFacts.ts server/test/callFacts.repo.test.ts
git commit -m "feat(calls): callFacts repo (upsert on message_id, read by message)"
```

---

## Task 5: Ingest orchestrator — message + facts in one call

**Files:**
- Create: `server/src/agent/abe/ingestCall.ts`
- Test: `server/test/ingestCall.test.ts`

Reuses the exact idempotent thread/message pattern from `mirrorCall.ts` (so existing readers see a
normal inbound message), then writes `call_facts`. Idempotent on `(tenant_id, message_ref)`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { ingestJobixCall } from '../src/agent/abe/ingestCall.js';
import { getCallFactsByMessage } from '../src/repos/callFacts.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

const body = {
  customer_data: {
    main: { suid: 's1', name: 'Renier', phone: '+27', timezone: 'Africa/Johannesburg' },
    values: { type: 'Seller', call_summary: 'wants to sell', call_outcome: 'completed' },
  },
};

describe('ingestJobixCall', () => {
  it('creates one inbound message + call_facts, idempotent on callRef', async () => {
    const t = await createTenant(pool);

    const r1 = await ingestJobixCall({ pool, tenantId: t.id, callRef: 'call-1', body, attribution: {} });
    expect(r1.created).toBe(true);

    const msg = await pool.query(
      `SELECT id, content, role, source FROM agent_messages WHERE tenant_id=$1 AND message_ref='call-1'`, [t.id]);
    expect(msg.rowCount).toBe(1);
    expect(msg.rows[0].role).toBe('inbound');
    expect(msg.rows[0].source).toBe('jobix');
    expect(msg.rows[0].content).toBe('wants to sell');

    const f = await getCallFactsByMessage(pool, msg.rows[0].id);
    expect(f?.caller_suid).toBe('s1');
    expect(f?.attribution_label).toBe('Seller');
    expect(f?.call_outcome).toBe('completed');

    const r2 = await ingestJobixCall({ pool, tenantId: t.id, callRef: 'call-1', body, attribution: {} });
    expect(r2.created).toBe(false);
    const cnt = await pool.query(`SELECT COUNT(*)::int AS n FROM agent_messages WHERE tenant_id=$1`, [t.id]);
    expect(cnt.rows[0].n).toBe(1);
  });

  it('falls back to subject/summary when no call_summary, never empty content', async () => {
    const t = await createTenant(pool);
    await ingestJobixCall({
      pool, tenantId: t.id, callRef: 'call-2',
      body: { customer_data: { main: { suid: 's2' }, values: { context: 'abandoned deposit' } } },
      attribution: {},
    });
    const msg = await pool.query(
      `SELECT content FROM agent_messages WHERE tenant_id=$1 AND message_ref='call-2'`, [t.id]);
    expect(msg.rows[0].content.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w server run test -- test/ingestCall.test.ts`
Expected: FAIL — `ingestCall.js` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
import type pg from 'pg';
import { normalizeCall, type AttributionMap } from './jobixPayload.js';
import { upsertCallFacts } from '../../repos/callFacts.js';

// Ingest one Jobix post-call payload. Creates the human-readable inbound message
// (same shape existing Abe readers expect) + the structured call_facts row.
// Idempotent on (tenant_id, message_ref = callRef). Returns created=false on re-delivery
// but still refreshes call_facts so corrections land.
export async function ingestJobixCall(args: {
  pool: pg.Pool; tenantId: string; callRef: string;
  body: unknown; attribution: AttributionMap; lineRef?: string | null;
}): Promise<{ created: boolean; messageId: string }> {
  const n = normalizeCall(args.body, args.attribution, args.lineRef);
  // content must never be empty (agent_messages.content is NOT NULL and readers expect text).
  const content = n.summary ?? n.callType ?? n.attributionLabel ?? 'Inbound call';

  const th = await args.pool.query<{ id: string }>(
    `INSERT INTO agent_threads (tenant_id, jobix_thread_ref)
       VALUES ($1, $2)
       ON CONFLICT (tenant_id, jobix_thread_ref) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [args.tenantId, `jobix:${n.callerSuid ?? args.callRef}`]);

  const ins = await args.pool.query<{ id: string }>(
    `INSERT INTO agent_messages (thread_id, tenant_id, role, source, content, status, message_ref)
       VALUES ($1,$2,'inbound','jobix',$3,'sent',$4)
       ON CONFLICT (tenant_id, message_ref) WHERE message_ref IS NOT NULL DO NOTHING
     RETURNING id`,
    [th.rows[0].id, args.tenantId, content, args.callRef]);

  const created = (ins.rowCount ?? 0) > 0;
  const messageId = created
    ? ins.rows[0].id
    : (await args.pool.query<{ id: string }>(
        `SELECT id FROM agent_messages WHERE tenant_id=$1 AND message_ref=$2`,
        [args.tenantId, args.callRef])).rows[0].id;

  await upsertCallFacts(args.pool, {
    ...n, tenantId: args.tenantId, messageId,
    rawPayload: (args.body ?? {}) as Record<string, unknown>,
  });

  return { created, messageId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w server run test -- test/ingestCall.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/agent/abe/ingestCall.ts server/test/ingestCall.test.ts
git commit -m "feat(calls): ingestJobixCall — message + call_facts, idempotent on callRef"
```

---

## Task 6: `attribution_map` on the config repo

**Files:**
- Modify: `server/src/repos/lineReportConfigs.ts`
- Test: `server/test/lineReport.configs.repo.test.ts` (add a case)

The route needs to read the tenant's `attribution_map`. Surface it on the existing config type.

- [ ] **Step 1: Read the current repo to match its shape**

Run (scoped): open `server/src/repos/lineReportConfigs.ts`, find the row interface and the
`SELECT` in `getLineReportConfig`. Note the exact field list so you extend, not rewrite.

- [ ] **Step 2: Write the failing test (append to the configs repo test)**

```ts
import { upsertLineReportConfig, getLineReportConfig } from '../src/repos/lineReportConfigs.js';
// ...existing imports/pool/setup in this file are reused...

it('round-trips attribution_map', async () => {
  const t = await createTenant(pool);
  await upsertLineReportConfig(pool, { tenantId: t.id, attributionMap: { source: 'values_key', values_key: 'department' } });
  const cfg = await getLineReportConfig(pool, t.id);
  expect(cfg?.attribution_map).toEqual({ source: 'values_key', values_key: 'department' });
});
```

> If `upsertLineReportConfig` does not yet accept partial updates with `attributionMap`, add that
> field to its input type and its `INSERT ... ON CONFLICT DO UPDATE` (mirroring how an existing
> jsonb field like `recipients` or `taxonomy` is handled in the same function). Add
> `attribution_map` to the row interface and the `SELECT` in `getLineReportConfig`.

- [ ] **Step 3: Run test to verify it fails**

Run: `npm -w server run test -- test/lineReport.configs.repo.test.ts`
Expected: FAIL — `attribution_map` undefined / column not selected.

- [ ] **Step 4: Implement — extend type, SELECT, and upsert**

In `lineReportConfigs.ts`:
- Add to the row interface: `attribution_map: { source?: 'agent'|'values_key'; values_key?: string };`
- Add `attribution_map` to the `SELECT` column list in `getLineReportConfig`.
- Add an optional `attributionMap?` to the upsert input and include it in both the column list and
  the `ON CONFLICT DO UPDATE SET` (serialize with `JSON.stringify`, default `{}`), following the
  pattern already used for the `recipients`/`taxonomy` jsonb fields in that function.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm -w server run test -- test/lineReport.configs.repo.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/repos/lineReportConfigs.ts server/test/lineReport.configs.repo.test.ts
git commit -m "feat(calls): surface attribution_map on line_report_configs repo"
```

---

## Task 7: Route — `POST /v1/jobix/calls`

**Files:**
- Create: `server/src/routes/v1Jobix.ts`
- Modify: `server/src/app.ts` (import + register)
- Test: `server/test/v1Jobix.route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { insertApiKey } from '../src/repos/apiKeys.js';
import { generateApiKey, hashApiKey, prefixOf } from '../src/auth/apiKey.js';

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

async function withKey() {
  const t = await createTenant(pool);
  const key = generateApiKey();
  await insertApiKey(pool, { tenantId: t.id, name: 'k', keyHash: hashApiKey(key), keyPrefix: prefixOf(key) });
  return { t, key };
}

const body = {
  company_key: 'V7E-...',
  customer_data: {
    main: { suid: 's1', name: 'Renier', phone: '+27', timezone: 'Africa/Johannesburg' },
    values: { type: 'Seller', call_summary: 'wants to sell', call_outcome: 'completed' },
  },
};

describe('POST /v1/jobix/calls', () => {
  it('401 without an API key', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/jobix/calls', payload: body });
    expect(r.statusCode).toBe(401);
  });

  it('ingests a call and is idempotent', async () => {
    const { t, key } = await withKey();
    const headers = { authorization: `Bearer ${key}` };

    const r1 = await app.inject({ method: 'POST', url: '/v1/jobix/calls', headers, payload: body });
    expect(r1.statusCode).toBe(202);
    expect(JSON.parse(r1.body).created).toBe(true);

    const r2 = await app.inject({ method: 'POST', url: '/v1/jobix/calls', headers, payload: body });
    expect(JSON.parse(r2.body).created).toBe(false);

    const cnt = await pool.query(`SELECT COUNT(*)::int AS n FROM agent_messages WHERE tenant_id=$1`, [t.id]);
    expect(cnt.rows[0].n).toBe(1);
    const f = await pool.query(`SELECT attribution_label, caller_suid FROM call_facts WHERE tenant_id=$1`, [t.id]);
    expect(f.rows[0].attribution_label).toBe('Seller');
    expect(f.rows[0].caller_suid).toBe('s1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w server run test -- test/v1Jobix.route.test.ts`
Expected: FAIL — route 404 (not registered).

- [ ] **Step 3: Implement the route**

`server/src/routes/v1Jobix.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sendError, AppError } from '../util/errors.js';
import { requireCtx } from '../auth/ctx.js';
import { ingestJobixCall } from '../agent/abe/ingestCall.js';
import { getLineReportConfig } from '../repos/lineReportConfigs.js';

// Lenient: Jobix shapes vary per tenant. We accept any object and let normalizeCall sort it out.
const Body = z.record(z.unknown());

// Derive a stable idempotency ref from the payload: prefer an explicit call id, else suid+timestamp.
function callRef(b: Record<string, unknown>): string {
  const cd = (b.customer_data ?? {}) as Record<string, unknown>;
  const main = (cd.main ?? {}) as Record<string, unknown>;
  const suid = (main.suid ?? b.suid ?? '') as string;
  const explicit = (b.call_id ?? b.call_ref ?? b.id) as string | undefined;
  if (explicit) return String(explicit);
  const ts = (b.timestamp ?? b.call_time ?? b.created_at ?? '') as string;
  return ts ? `${suid}:${ts}` : `${suid}`;
}

export async function registerV1JobixRoutes(app: FastifyInstance) {
  app.post('/v1/jobix/calls', async (req, reply) => {
    try {
      const ctx = requireCtx(req);
      if (ctx.role !== 'api_key') throw new AppError('unauthorized', 401, 'API key required');
      const b = Body.parse(req.body ?? {});
      const ref = callRef(b);
      if (!ref || ref === ':') throw new AppError('bad_request', 400, 'Cannot derive a call reference (need suid or call id)');

      const cfg = await getLineReportConfig(app.pool, ctx.tenantId);
      const attribution = (cfg?.attribution_map ?? {}) as { source?: 'agent'|'values_key'; values_key?: string };

      const out = await ingestJobixCall({
        pool: app.pool, tenantId: ctx.tenantId, callRef: ref, body: b, attribution,
        lineRef: (b.company_key as string | undefined) ?? null,
      });
      return reply.code(202).send({ created: out.created, message_id: out.messageId });
    } catch (e) { sendError(reply, e); }
  });
}
```

In `server/src/app.ts`: add `import { registerV1JobixRoutes } from './routes/v1Jobix.js';` with the
other route imports, and `await registerV1JobixRoutes(app);` alongside `await registerV1EmailRoutes(app);`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w server run test -- test/v1Jobix.route.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/v1Jobix.ts server/src/app.ts server/test/v1Jobix.route.test.ts
git commit -m "feat(calls): POST /v1/jobix/calls webhook (API-key auth, idempotent ingest)"
```

---

## Task 8: Backfill also populates `call_facts`

**Files:**
- Modify: `server/src/agent/abe/backfillCalls.ts`
- Test: `server/test/callFacts.backfill.test.ts`

Legacy/backfilled calls have a message but no `call_facts`. Give them a minimal facts row
(`summary = content`, structured fields null, `resolution_state='open'`) so the `calls` view and
future #3 analytics see *every* call uniformly. Idempotent (upsert on message_id).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { backfillCallFactsForTenant } from '../src/agent/abe/backfillCalls.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function seedInbound(tenantId: string, ref: string, content: string): Promise<string> {
  const th = await pool.query<{ id: string }>(
    `INSERT INTO agent_threads (tenant_id, jobix_thread_ref) VALUES ($1,$2) RETURNING id`, [tenantId, `t:${ref}`]);
  const m = await pool.query<{ id: string }>(
    `INSERT INTO agent_messages (thread_id, tenant_id, role, source, content, status, message_ref)
     VALUES ($1,$2,'inbound','jobix',$3,'sent',$4) RETURNING id`, [th.rows[0].id, tenantId, content, ref]);
  return m.rows[0].id;
}

describe('backfillCallFactsForTenant', () => {
  it('creates a facts row for messages lacking one, idempotently', async () => {
    const t = await createTenant(pool);
    const m1 = await seedInbound(t.id, 'r1', 'old call about arrears');

    const n1 = await backfillCallFactsForTenant(pool, t.id);
    expect(n1).toBe(1);
    const f = await pool.query(`SELECT summary, resolution_state FROM call_facts WHERE message_id=$1`, [m1]);
    expect(f.rows[0].summary).toBe('old call about arrears');
    expect(f.rows[0].resolution_state).toBe('open');

    const n2 = await backfillCallFactsForTenant(pool, t.id);
    expect(n2).toBe(0); // idempotent
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w server run test -- test/callFacts.backfill.test.ts`
Expected: FAIL — `backfillCallFactsForTenant` not exported.

- [ ] **Step 3: Implement (append to `backfillCalls.ts`)**

```ts
// Give every inbound jobix message a call_facts row (summary = content, structured fields null).
// For legacy/mirror calls that predate the webhook. Idempotent via the unique(message_id).
export async function backfillCallFactsForTenant(pool: pg.Pool, tenantId: string): Promise<number> {
  const r = await pool.query(
    `INSERT INTO call_facts (tenant_id, message_id, summary)
       SELECT m.tenant_id, m.id, m.content
         FROM agent_messages m
         LEFT JOIN call_facts f ON f.message_id = m.id
        WHERE m.tenant_id = $1 AND m.role = 'inbound' AND m.source = 'jobix' AND f.id IS NULL
     ON CONFLICT (message_id) DO NOTHING`,
    [tenantId]);
  return r.rowCount ?? 0;
}
```

Then, in `backfillCallsFromEmails`, after the import loop (after `ensureCategories`), add:
```ts
  await backfillCallFactsForTenant(args.pool, args.tenantId);
```
so the existing one-click "Import past calls" also seeds facts. (`backfillCallsFromEmails`'s return
shape is unchanged — facts seeding is a side effect.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w server run test -- test/callFacts.backfill.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/agent/abe/backfillCalls.ts server/test/callFacts.backfill.test.ts
git commit -m "feat(calls): backfill call_facts for legacy inbound calls"
```

---

## Task 9: `calls` view non-breakage test (webhook + legacy together)

**Files:**
- Test: `server/test/callsView.test.ts`

Proves the view returns rows for BOTH a webhook-ingested call (has facts) and a legacy mirror call
(no facts) — the core "don't break existing flows" guarantee at the data layer.

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { ingestJobixCall } from '../src/agent/abe/ingestCall.js';
import { mirrorEmailAsCall } from '../src/agent/abe/mirrorCall.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('calls view', () => {
  it('returns both webhook calls (with facts) and legacy mirror calls (no facts)', async () => {
    const t = await createTenant(pool);

    await ingestJobixCall({
      pool, tenantId: t.id, callRef: 'w1',
      body: { customer_data: { main: { suid: 's1' }, values: { type: 'Seller', call_summary: 'webhook call' } } },
      attribution: {},
    });
    await mirrorEmailAsCall({ pool, tenantId: t.id, emailId: 'legacy-1', summary: 'legacy mirror call' });

    const r = await pool.query(
      `SELECT summary_text, attribution_label, call_type FROM calls WHERE tenant_id=$1 ORDER BY summary_text`, [t.id]);
    expect(r.rowCount).toBe(2);
    // legacy row: no facts -> attribution_label is null but the call still appears
    const legacy = r.rows.find(x => x.summary_text === 'legacy mirror call');
    expect(legacy).toBeTruthy();
    expect(legacy.attribution_label).toBeNull();
    // webhook row: facts present
    const wh = r.rows.find(x => x.summary_text === 'webhook call');
    expect(wh.call_type).toBe('Seller');
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm -w server run test -- test/callsView.test.ts`
Expected: PASS (both rows present; legacy has null facts).

- [ ] **Step 3: Commit**

```bash
git add server/test/callsView.test.ts
git commit -m "test(calls): calls view covers webhook + legacy mirror calls"
```

---

## Task 10: Full suite + strict build (non-breakage gate)

**Files:** none (verification only)

- [ ] **Step 1: Run the full server suite (serial)**

Run: `npm -w server run test`
Expected: ALL green — especially the existing email tests (`v1Emails`, `pipeline`, `render`,
`templates*`, `tracking`, `suppressions`) and existing call tests (`callIngestion.*`,
`callAnalytics.*`, `lineReport.*`, `handover.*`). No regressions.

- [ ] **Step 2: Strict typecheck/build**

Run: `npm -w server run build`
Expected: `tsc` passes with no errors.

- [ ] **Step 3: If anything fails**

Use superpowers:systematic-debugging. Do not paper over a failure — a broken existing email test
violates the hard constraint.

- [ ] **Step 4: Commit (only if any fix was needed)**

```bash
git add -A
git commit -m "fix(calls): address full-suite/build issues from call_facts foundation"
```

---

## Done criteria

- New `POST /v1/jobix/calls` ingests structured Jobix calls (caller identity + outcome +
  attribution), idempotent, API-key authed.
- `call_facts` + `calls` view exist; every inbound jobix call (webhook or legacy) is in the view.
- `attribution_map` configurable per tenant; default heuristic works for the Postman samples.
- Backfill seeds facts for legacy calls.
- Full server suite green; strict `tsc` passes; **no existing email flow modified**.

## Out of scope (next sub-projects)

- `call_actions` (tasks / handover / outbound-comms as lifecycle'd actions) → sub-project #2.
- Abe's attribution-aware "who's getting the most calls & why" + department UI → sub-project #3.
- LLM enrichment of `sentiment`/`call_type` when Jobix omits them.
