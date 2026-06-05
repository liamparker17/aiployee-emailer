# Call Analytics Center — Slice A (Read) Design

**Date:** 2026-06-05
**Status:** Design approved (pending spec review)
**Scope:** Slice A of 2. The **read** analytics center. Actions (Slice B) deferred.

---

## 0. Why

The agentic call DB foundation now stores structured per-call data in `call_facts` (caller
identity, attribution/department, type, outcome, sentiment, duration, callback/escalation flags,
resolution state) surfaced through the `calls` view. But the tenant **Calls page** still reads only
`agent_messages` + `line_call_tags` — it shows Date / Category / Severity / Excerpt and aggregates
by category alone. None of the new structured dimensions are exposed.

The user wants a **Call Analytics Center**: a single surface that gives the **big-picture view**
(volumes by department/category/outcome/sentiment, resolution/FCR, "who's getting the most calls
and why" — the MD view) *and* lets you drop into an **Excel-style grid of individual calls** with
the structured columns when you want detail — replacing today's line-by-line reporting.

This is an **evolution of the existing Calls page**, not a rebuild. Slice A is **read-only**: no
writes, no send-gate. Actions (follow-up tasks, forward/escalate, outbound comms, resolution
disposition) are Slice B.

## 0.1 Non-negotiable constraints

- **Additive / no regression.** Existing routes keep working; `call_handovers` and the send
  pipeline are untouched. Tenants with no `call_facts` rows (or not yet backfilled) must still see
  their calls — the `calls` view LEFT-JOINs facts, so structured columns are simply null.
- **Scope parity.** Switching the explorer/breakdown to the `calls` view must return the **same set
  of calls** the current page shows (inbound Jobix calls). Verified by test.
- **Role gating unchanged:** every route stays `tenant_admin` OR `super_admin` (no `tenant_user`).

---

## 1. Data layer — `server/src/repos/callAnalytics.ts`

Read from the **`calls` view** instead of the ad-hoc `agent_messages`+`line_call_tags` join.

### 1.1 `listCalls` — widen the row + filters
`CallRow` gains the structured columns (all nullable):
```ts
interface CallRow {
  id: string;            // = calls.message_id
  created_at: Date;
  content: string;       // = calls.summary_text
  category: string | null; severity: string | null;
  caller_name: string | null; caller_phone: string | null;
  attribution_label: string | null; call_type: string | null;
  call_outcome: string | null; sentiment: string | null;
  call_duration_seconds: number | null;
  callback_requested: boolean | null; escalation_requested: boolean | null;
  resolution_state: string | null;
}
```
`opts` gains optional filters (all combine with AND; absent = no constraint):
`category, search, from, to, limit, offset` (existing) **+** `attribution`, `outcome`, `sentiment`,
`resolution`, `callbackRequested?: boolean`, `escalationRequested?: boolean`, and a `sort` of
`{ field: 'created_at'|'attribution_label'|'category'|'call_outcome'|'sentiment'|'call_duration_seconds'|'resolution_state', dir: 'asc'|'desc' }`
(default `created_at desc`). `field` is validated against an allow-list (no raw SQL interpolation).
Returns `{ calls: CallRow[], total }` as today.

### 1.2 `callAnalyticsSummary(pool, tenantId, start, end)` (new)
One pass over the window → headline metrics:
`{ total, resolved, resolutionRatePct, fcrCount, callbackCount, escalationCount,
   avgDurationSeconds, sentimentMix: {positive,neutral,negative,unknown},
   outcomeMix: Array<{outcome, count}> }`.

### 1.3 `breakdownBy(pool, tenantId, dimension, start, end)` (new)
Generic grouped counts for `dimension ∈ {attribution_label, category, call_outcome, sentiment, resolution_state}`
(allow-listed) → `Array<{ key: string|null, count: number }>` ordered desc. NULL key surfaces as
`'(unattributed)'`/`'(uncategorised)'` at the route layer.

### 1.4 `crosstabDeptCategory(pool, tenantId, start, end)` (new)
The headline "who & why": `Array<{ attribution_label: string|null, category: string|null, count }>`
for a stacked/grouped view.

Keep existing `breakdownByCategory`, `callsPerDay`, `countCallsMatching`, `searchEmails`, `getCall`,
`sampleInboundContents`, `deleteTagsForTenant`. `getCall` widens to the new `CallRow`.

All queries are parameterized; `dimension`/`sort.field` come only from server-side allow-lists.

---

## 2. Routes — `server/src/routes/callAnalytics.ts`

| Method | Path | Change |
|---|---|---|
| GET | `/api/calls` | Accept the new filters + `sort` + `sortDir`; return widened rows. Back-compatible (new params optional). |
| GET | `/api/calls/breakdown` | Return `{ summary, byCategory, byDepartment, byOutcome, bySentiment, byResolution, crosstab, perDay }` for the window (today/7d/30d). Existing `byCategory`+`perDay` keys retained so the current UI keeps working mid-migration. |
| GET | `/api/calls/export.csv` | **New.** Same filters as `/api/calls` (no pagination; capped at 5000 rows, `log()`-noted if capped). Streams `text/csv` with the structured columns + a `Content-Disposition: attachment` header. |
| GET | `/api/calls/:id` | Returns the widened row. |

All `tenant_admin`/`super_admin` gated, same as today. Validation via zod; unknown sort/dimension → 400.

---

## 3. Frontend — `web/src/pages/Calls.tsx`

### 3.1 `BreakdownPanel` → multi-dimension dashboard
Above the existing per-day trend, add metric cards and breakdowns from `/api/calls/breakdown`:
- **Headline:** "Who & why" — department × category (stacked bars or a compact matrix) from `crosstab`.
- **Metric cards:** total calls, resolution rate %, FCR count, callbacks, escalations, avg duration.
- **Mini-breakdowns:** outcome mix, sentiment split, by department, by resolution state (each a
  small ranked bar list reusing the existing bar component).
- Time-window toggle (Today/7d/30d) unchanged. Degrades gracefully when facts are null
  (e.g. sentiment shows "unknown").

### 3.2 `ExplorerPanel` → Excel-style grid
- Columns: Time, Caller (name + phone), **Department** (attribution_label), Type, Category,
  **Outcome**, **Sentiment** (chip), Duration (mm:ss), Callback (✓), Escalation (✓),
  **Resolution** (chip), Excerpt. Horizontal scroll on desktop; mobile keeps the card layout with
  the key fields.
- **Sort** by clicking sortable headers (maps to `sort`/`sortDir`). **Filters:** existing
  search + category + date range, plus dropdowns for department, outcome, sentiment, resolution,
  and toggles for callback/escalation. Pagination unchanged (50/page).
- **Export CSV** button → hits `/api/calls/export.csv` with the current filters.
- Row click → drill-down modal.

### 3.3 Drill-down modal (read-only)
Shows the full structured record: caller block, department/type, outcome, sentiment, duration,
callback (+preferred time), escalation, resolution state, category/severity, full summary text, and
the raw `call_values` as a small key/value list. No edit controls (those arrive in Slice B).

Other panels (FirstRun, Categories, AskAbe, Settings) unchanged.

---

## 4. Data flow

Jobix webhook / mirror → `agent_messages` + `call_facts` → **`calls` view** → `callAnalytics` repo
(`listCalls`, `callAnalyticsSummary`, `breakdownBy`, `crosstabDeptCategory`) → routes → Calls page
(dashboard + grid + drill-down). One read path; the view is the single source.

## 5. Error handling

- Bad `sort`/`dimension`/filter enum → 400 (zod + allow-list).
- Empty/zero-call tenant → summary zeros, empty breakdowns, empty grid (existing empty states).
- Null structured fields render as "—"/"unknown"; never crash.
- CSV cap (5000) → return the cap with a header/flag noting truncation.

## 6. Testing (Vitest, serial, Neon test branch)

- **Repo:** `listCalls` honours each new filter and `sort` (allow-list rejects bad field);
  `callAnalyticsSummary` computes resolution rate / FCR / callback / escalation / avg duration /
  mixes over a seeded set; `breakdownBy` groups each allowed dimension; `crosstabDeptCategory`
  returns dept×category counts; NULL facts bucket as unattributed/unknown.
- **Scope parity:** a tenant with mixed legacy-mirror (no facts) + webhook (facts) calls returns
  ALL of them via `listCalls`/breakdown (LEFT JOIN), matching the pre-change call set.
- **Routes:** `/api/calls` back-compatible with no new params; new filters work; `/api/calls/breakdown`
  returns all keys; `/api/calls/export.csv` returns `text/csv` with header row + rows honouring
  filters + cap; role gating (non-admin → 403/401); bad sort → 400.
- **Non-breakage:** existing `callAnalytics.*` tests stay green; full suite green; strict `tsc`.

`npm -w server run build` must pass before any push.

## 7. Out of scope (Slice B)

- `call_actions` table + follow-up tasks / forward / approval-gated outbound comm / resolution
  disposition; the cross-call worklist; surfacing `call_handovers` in a unified view.
- Writing/editing resolution_state (read-only display only in Slice A).
- Abe chat tools for the new dimensions (current `search_calls`/`top_call_reasons` unchanged).
- Saved views, scheduled exports, per-user column prefs.
