# Agentic Call DB — Foundation (Call Record + Structured Ingestion)

**Date:** 2026-06-05
**Status:** Design approved (pending spec review)
**Scope:** Sub-project #1 of 3. Foundation only.

---

## 0. Why (the reframe)

Today there is **no first-class "call."** A call is an `agent_messages` row (free-text
`content`, `role=inbound`, `source=jobix`) plus a `line_call_tags` row (category + severity).
The analysis layer — `line_reports`, `call_handovers`, the Calls page — was built on top of a
record that doesn't really exist. That is the "cart before horse."

Two compounding problems:

1. **No structured record.** Attribution (*who* the call is for), the call **outcome**, and a
   **resolution lifecycle** have nowhere to live.
2. **Structured data is discarded at ingestion.** Jobix already emits structured call data
   (see §2), but the current integration funnels everything through an email `{{summary}}`
   template, flattening it to free text — then Abe re-derives category with an LLM tagger.
   We re-infer data Jobix already handed us.

**The reframe:** a call becomes a first-class record — *who* (attribution), *what* (type/category),
an **outcome**, a **resolution lifecycle**, and (later) **actions** hanging off it. Reporting,
handovers, and "who's getting the most calls and why" become **views and actions over that
record**, not bespoke features.

## 0.1 Non-negotiable constraint

**This must not break any existing email flow.** The emailer (send pipeline, templates, email
events, suppressions, campaigns) is the core product. Every change here is **additive**: a new
endpoint, a new table, a new view. The existing send-path mirror (`captureCallFromSend` /
`mirrorEmailAsCall` in `server/src/agent/abe/mirrorCall.ts`) is **left exactly as-is** as a legacy
fallback. The send pipeline is not modified.

## 0.2 Decomposition (foundation first)

| # | Sub-project | This spec? |
|---|-------------|-----------|
| 1 | **Call record + structured ingestion + outcome + attribution** | ✅ this spec |
| 2 | `call_actions` — follow-up tasks / handover / outbound-comms as lifecycle'd action types | deferred |
| 3 | Abe's agentic query+act layer ("who's getting the most calls & why") + department UI | deferred |

Mafadi's department filtering and the MD's ask-Abe-anything fall out of #1 + #3. #1 is the horse:
a real call record fed by structured ingestion. Build it first; #2 and #3 read it.

---

## 1. Architecture decision

**Calls view + facts** (chosen over a full `calls`-table restructure and over extend-in-place):

- Keep `agent_messages` as the **human-readable spine** (so every existing reader — Calls page,
  `search_calls`, reports, handovers — keeps working unchanged).
- Add a **`call_facts`** table (1:1 with the inbound message) holding the structure.
- Expose a **`calls` SQL view** joining `agent_messages` ⋈ `call_facts` ⋈ `line_call_tags`, so all
  new code reads a clean "call."

Rationale: first-class call abstraction *now*, lowest migration risk, reuses existing idempotency
and backfill, and can be collapsed into a real table later without churning consumers.

---

## 2. The Jobix payload (source of truth for ingestion)

Jobix supports an outbound **post-call webhook** to an arbitrary URL (proven by the
"Buyer Update Payload → webhook.site" request in the Postman collection). Representative shapes:

**Post-call webhook (the outcome event):**
```json
{ "suid": "...", "call_summary": "...", "call_outcome": "completed",
  "callback_requested": false, "callback_preferred_time": null,
  "escalation_requested": false, "call_duration": "3 minutes 42 seconds" }
```

**Customer-save shape (`/v1/customer/save`), `values` is tenant-specific:**
```json
{ "company_key": "V7E-...", "customer_data": {
    "main":   { "suid": "...", "name": "...", "phone": "...", "timezone": "Africa/Johannesburg" },
    "values": { "unit_number": "103", "building_name": "Sky Place", "arrears_amount": 2449.46 } } }
```

Observations that drive the model:

- **Outcome fields exist in the payload:** `call_outcome`, `sentiment`, `callback_requested`,
  `callback_preferred_time`, `escalation_requested`, `call_duration`, `summary`/`call_summary`,
  and tenant signals like `right_person_reached`, `voucher_accepted`.
- **Attribution lives in two places:**
  1. **Which Jobix agent/line** — a tenant runs multiple agents (Weelee: separate Seller and
     Buyer). The line itself is a department signal.
  2. **A call-type label inside `values`**, under inconsistent keys per tenant:
     `type` (Seller/Buyer), `Call`/`call` ("Booking Confirmation"), `context` ("abandoned
     deposit"), `call_purpose`.
- **`company_key` → tenant** is the routing key.
- **Business data is free-form `values` jsonb**, different per tenant.

---

## 3. Ingestion — new Jobix webhook

**Endpoint:** `POST /v1/jobix/calls` (new route; does not touch existing `/v1/emails`).

**Auth:** resolve `company_key` → tenant; require a shared secret (HMAC header or bearer) —
configured per environment. Reject unknown `company_key` or bad signature.

**Idempotency:** stable call id = Jobix call ref if present, else `suid` + call timestamp.
Reuse the existing `agent_messages (tenant_id, message_ref)` unique index — `message_ref` = that
stable id (mirrors `mirrorEmailAsCall`'s pattern). Re-delivery is a no-op.

**Per call, in one transaction:**
1. Upsert `agent_threads` (a stable per-line or per-caller `jobix_thread_ref`, e.g. `jobix:<suid>`).
2. Insert `agent_messages` (`role='inbound'`, `source='jobix'`, `content=summary`,
   `status='sent'`, `message_ref=<stable id>`) — `ON CONFLICT DO NOTHING`. *Same shape existing
   readers already expect.*
3. Insert `call_facts` for that message (see §4), populated from the payload.

If the message already existed (idempotent re-delivery), upsert `call_facts` to keep it current
without duplicating the message.

**Legacy coexistence:** the email-`{{summary}}` mirror remains for any tenant still on that path.
Once a tenant's Jobix agent points at the webhook, the webhook is authoritative for them. No
data migration of the mirror is required; both produce `agent_messages` rows the same way.

---

## 4. Data model — `call_facts`

Migration `1700000000030_call_facts.cjs`. 1:1 with the inbound message.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid pk | |
| `tenant_id` | uuid not null → tenants | CASCADE |
| `message_id` | uuid not null → agent_messages | **unique**, CASCADE |
| `caller_suid` | text | Jobix `customer_data.main.suid` — stable caller id (repeat-caller/FCR) |
| `caller_name` | text | `customer_data.main.name` |
| `caller_phone` | text | `customer_data.main.phone` |
| `caller_timezone` | text | `customer_data.main.timezone` |
| `line_ref` | text | which Jobix agent/line (attribution source) |
| `attribution_label` | text | resolved department/owner (§5) |
| `call_type` | text | Seller / "Booking Confirmation" / "abandoned deposit"… |
| `summary` | text | `call_summary` / `summary` |
| `call_outcome` | text | e.g. `completed` |
| `sentiment` | text | when provided |
| `call_duration_seconds` | int | parsed from `call_duration` |
| `callback_requested` | boolean default false | |
| `callback_preferred_time` | text | free text/time as given |
| `escalation_requested` | boolean default false | |
| `resolution_state` | text default `'open'` | check `open / in_progress / resolved / unresolved` |
| `resolved_at` | timestamptz | |
| `resolved_by` | uuid → users (SET NULL) | |
| `fcr` | boolean | nullable (first-call-resolution) |
| `values` | jsonb default `'{}'` | raw tenant-specific business fields |
| `raw_payload` | jsonb default `'{}'` | full webhook payload, for audit/replay |
| `created_at` / `updated_at` | timestamptz default now() | |

Indexes: `(tenant_id, created_at desc)`, `(tenant_id, attribution_label)`,
`(tenant_id, resolution_state)`, `(tenant_id, caller_suid)` (repeat-caller / FCR lookups).

`line_call_tags` (Abe-inferred category/severity) is **unchanged**. `call_facts` is the
payload-derived dimension; the LLM tagger only enriches what Jobix does *not* provide.

### `calls` view
```sql
CREATE VIEW calls AS
SELECT m.id AS message_id, m.tenant_id, m.content AS summary_text, m.created_at,
       f.caller_suid, f.caller_name, f.caller_phone,
       f.line_ref, f.attribution_label, f.call_type, f.call_outcome, f.sentiment,
       f.callback_requested, f.escalation_requested, f.resolution_state, f.fcr,
       f.values, t.category, t.severity
FROM agent_messages m
LEFT JOIN call_facts f      ON f.message_id = m.id
LEFT JOIN line_call_tags t  ON t.message_id = m.id
WHERE m.role = 'inbound' AND m.source = 'jobix';
```
New code reads `calls`. (Stays a view; can become a materialized table later.)

---

## 5. Per-tenant attribution config

Add `attribution_map` jsonb to `line_report_configs` (migration column add):
```json
{ "source": "values_key", "values_key": "type" }   // or { "source": "agent" }
```
Resolution at ingest:
- `source: "agent"` → `attribution_label = line_ref` (the Jobix agent/line).
- `source: "values_key"` → read `values[values_key]`.
- **Default when unset:** first present of `type → Call → call → context → call_purpose`,
  else null. Lets Mafadi map its department signal with no code change.

`call_type` is populated by the same heuristic independently of `attribution_label` (a call can
have both a department and a type).

---

## 6. Backfill

Extend the existing `import-past` path to populate `call_facts` for historical `agent_messages`
that lack one: create a `call_facts` row with `summary = content`, structured fields **null**
(old data has no structure), `resolution_state='open'`. Best-effort; the webhook is the clean
forward path. No new endpoint — fold into the existing importer so a tenant's one-click backfill
also gets `call_facts`.

---

## 7. Compatibility & non-breakage (explicit)

- **Send pipeline / templates / email events:** untouched. New endpoint only.
- **`mirrorCall.ts`:** untouched (legacy fallback).
- **Existing Abe readers** (`lineTagger`, `lineReports`, `callHandovers`, `callAnalytics`,
  `search_calls`): keep reading `agent_messages`; `call_facts` is additive and nullable, so a
  call with no facts row still behaves exactly as today.
- **Cron** (`/v1/cron/line-report`): unchanged; tagging still runs over `agent_messages`.

---

## 8. Testing

Server tests run serially against the Neon test branch (see project memory).

- **Ingest happy path:** webhook → one `agent_messages` + one `call_facts`, fields mapped
  (caller suid/name/phone from `customer_data.main`, outcome, callback flags, duration parsed,
  `values`/`raw_payload` stored).
- **Idempotency:** same call id twice → one message, `call_facts` upserted not duplicated.
- **Auth:** bad/missing secret → 401; unknown `company_key` → 404/403.
- **Attribution:** `source: agent`, `source: values_key`, and default heuristic each resolve
  `attribution_label` / `call_type` correctly; missing keys → null (no crash).
- **Duration parsing:** "3 minutes 42 seconds" → 222; malformed → null.
- **Non-breakage:** existing mirror test still green; a call without `call_facts` still tags and
  reports as before; `calls` view returns rows for both webhook and legacy-mirror calls.
- **Backfill:** importer creates `call_facts` for legacy rows, idempotently.

`npm -w server run build` (strict `tsc`) must pass before any push — vitest/tsx does not typecheck.

---

## 9. Out of scope (deferred)

- `call_actions` (follow-up tasks, handover, outbound comms as lifecycle'd actions) → #2.
- Abe's attribution-aware analytics + department dashboard / MD ask-anything → #3.
- LLM enrichment of `sentiment`/`call_type` when Jobix omits them → #2/#3 (the column exists now).
- Real-time alerts / Slack-Teams-WhatsApp delivery → later roadmap.
