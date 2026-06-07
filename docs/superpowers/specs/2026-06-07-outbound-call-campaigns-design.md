# Outbound Call Campaigns — Design (Agentic Voice, outbound)

**Date:** 2026-06-07
**Status:** Design approved (pending spec review)
**Scope:** A new slice of the Calls surface: launch **outbound** Jobix calls in bulk via a
**call campaign** runner, with a mandatory human approval gate. Closes the loop with the existing
inbound call pipeline.

---

## 0. Why

The pitch deck's hero is an **Omnichannel Command Centre** governing Voice (Jobix), WhatsApp and
Email. Today the codebase has Email (full), **inbound** Voice (Jobix → `/v1/jobix/calls` →
`call_facts` → Call Analytics Center), Abe (analyst/advisor), and B1 (internal call actions, no
sending). The missing lever is **outbound voice** — the deck's "Agentic Voice: inbound & outbound
calls 24/7". This slice builds it: an admin picks a Jobix agent, enrols a list of recipients,
reviews, approves, and the system launches calls through Jobix, tracking each recipient through to
its real-call outcome.

This is one slice toward the Command Centre, not the whole vision. WhatsApp, the unified inbox,
cross-channel analytics, billing, and the autonomous "management agent" are explicitly out of scope.

### The Jobix mechanism

There is exactly one clean server-to-server Jobix endpoint that launches a call:

```
POST https://dashboard-api.jobix.ai/v1/customer/save
Content-Type: application/json
{
  "company_key": "<tenant's Jobix agent key — this is the auth AND routes to one agent>",
  "customer_data": {
    "main":   { "suid": "<our stable id>", "name": "...", "phone": "+27...", "timezone": "Africa/Johannesburg" },
    "values": { ...free-form, agent-specific fields the agent uses on the call... }
  }
}
```

`company_key` both authenticates and selects which configured Jobix agent does the calling (there
is no agent id in the payload). `values` is agent-specific (e.g. Mafadi arrears agent expects
`unit_number`/`arrears_amount`; EZAuto expects `risk_score`/`deposit_due_date`).

The `aiployee.jobix.ai/ai-agent/*` endpoints in the Postman collection are **browser-session**
(PHPSESSID + CSRF) UI routes, **not** an integration API — they are not used by this design.

## 0.1 Non-negotiable constraints

- **Additive / no regression:** three new tables, two new route files, one new cron, a new frontend
  area. The **only** change to existing code is a single additive `linkResultBySuid` call inside the
  existing `/v1/jobix/calls` handler — a no-op when a call did not originate from a campaign.
- **Role gating:** every new route is `tenant_admin` OR `super_admin` (no `tenant_user`), matching
  the rest of the Calls surface (`requireAdmin(requireTenantCtx(req))`).
- **Mandatory human approval:** no `customer/save` fires until a campaign is explicitly approved.
- **Secret hygiene:** `company_key` is stored encrypted (same pattern as
  `jobix_webhook_secret_encrypted`, migration 009) and is **never** returned to any client.

## 0.2 Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Slice scope | Outbound voice **+ campaign runner** (bulk enrol, track as a batch) |
| Agents per tenant | **Many** — a `call_agents` registry; each campaign selects one agent |
| Recipient source | **Both** a saved list/segment **and** ad-hoc CSV upload, resolved against the agent's values schema |
| Send gate | **Mandatory human approval** (`draft → approved`) before any call fires |
| Consent / DNC | **Deferred** to a later slice — a `suppressed` status + a no-op `checkSuppressed` hook ship now (see §8) |
| Execution | **Background cron queue**, launch immediately on approval; Jobix handles dialing/concurrency |

---

## 1. Data model — migration `1700000000031_call_campaigns.cjs`

Three new tables, all additive. **Migration number:** B1's (unbuilt) `call_actions` design also
reserved `031`. The two slices are independent and neither is built yet — **whichever ships first
takes `1700000000031`, the other takes `032`.** This spec is written assuming this slice ships first;
if B1 lands first, renumber this migration to `032` (no other change).

### 1.1 `call_agents` — the Jobix agent registry (many per tenant)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `tenant_id` | uuid notNull → tenants | CASCADE |
| `label` | text notNull | e.g. "Arrears Collection". Unique `(tenant_id, label)` |
| `company_key_encrypted` | bytea notNull | encrypted with `ENC_KEY` (same helper as `jobix_webhook_secret_encrypted`). Never returned to client. |
| `values_schema` | jsonb notNull default `'[]'` | array of `{ key, label, required, type? }` — the fields this agent expects in `customer_data.values` |
| `default_timezone` | text default `'Africa/Johannesburg'` | |
| `active` | boolean notNull default `true` | |
| `created_by` | uuid → users (SET NULL) | |
| `created_at` / `updated_at` | timestamptz default now() | |

Indexes: `(tenant_id)`, unique `(tenant_id, label)`.

### 1.2 `call_campaigns` — mirrors email `campaigns`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `tenant_id` | uuid notNull → tenants | CASCADE |
| `agent_id` | uuid notNull → call_agents | **RESTRICT** (can't delete an agent that has campaigns) |
| `name` | text notNull | |
| `audience_type` | text notNull | check `IN ('list','segment','csv')` |
| `audience_id` | uuid | list/segment id; null for csv |
| `scheduled_for` | timestamptz | null = launch on approval |
| `status` | text notNull default `'draft'` | check `IN ('draft','approved','running','paused','completed','canceled')` — **`draft→approved` is the human gate** |
| `recipient_count` | int notNull default 0 | maintained as recipients are added |
| `approved_by` | uuid → users (SET NULL) | |
| `approved_at` | timestamptz | |
| `created_by` | uuid → users (SET NULL) | |
| `created_at` / `updated_at` | timestamptz default now() | |

Indexes: `(tenant_id, status)`, `(agent_id)`.

### 1.3 `call_campaign_recipients` — per-recipient, mirrors `emails` rows

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `tenant_id` | uuid notNull → tenants | CASCADE (denormalized for scoping/index) |
| `campaign_id` | uuid notNull → call_campaigns | CASCADE |
| `suid` | text notNull | our stable id → Jobix `customer_data.main.suid`. Unique `(tenant_id, suid)` |
| `name` | text notNull | → `customer_data.main.name` |
| `phone` | text notNull | → `customer_data.main.phone` |
| `timezone` | text | falls back to the agent's `default_timezone` |
| `values` | jsonb notNull default `'{}'` | resolved per-recipient `customer_data.values` |
| `contact_id` | uuid → contacts (SET NULL) | set when sourced from a list/segment |
| `status` | text notNull default `'pending'` | check `IN ('pending','queued','launched','failed','suppressed','completed','canceled')` |
| `attempts` | int notNull default 0 | launch attempts |
| `last_error` | text | last failure reason |
| `jobix_response` | jsonb | the `customer/save` response |
| `launched_at` | timestamptz | set on first 2xx |
| `result_message_id` | uuid → agent_messages (SET NULL) | the inbound call this produced (linked via `suid`) |
| `outcome` | text | mirrored from the result (completed/callback/escalation…) |
| `created_at` / `updated_at` | timestamptz default now() | |

Indexes: `(campaign_id, status)`, unique `(tenant_id, suid)`, `(result_message_id)`.

**Recipient lifecycle:** `pending → queued` (worker claims) `→ launched` (customer/save 2xx) `→
completed` (inbound result linked); or `→ failed` (after MAX retries); `suppressed` (reserved for the
deferred consent hook); `canceled` (campaign canceled).

**`suid` generation:** a stable, campaign-scoped id per recipient (e.g. `<campaignId>-<rowIndex>` or
a generated uuid stored on the row). Stability is what makes re-POSTing `customer/save` idempotent.

---

## 2. Repo layer

### 2.1 `server/src/repos/callAgents.ts` (new)
- `createAgent(pool, { tenantId, label, companyKey, valuesSchema, defaultTimezone?, createdBy }) → AgentRow`
  — encrypts `companyKey` → `company_key_encrypted` (reusing the existing ENC_KEY encrypt helper).
  Returns the row **without** the key.
- `listAgents(pool, tenantId) → AgentPublic[]` — key never included; returns `hasKey: true` + a
  last-4 hint only.
- `getAgentForLaunch(pool, tenantId, agentId) → { ...row, companyKey }` — **server-only**, decrypts
  the key. Used solely by the worker; never reachable from a route response.
- `updateAgent(pool, tenantId, agentId, patch) → AgentRow | null` — label / `values_schema` /
  `active`, and optional key rotation.

### 2.2 `server/src/repos/callCampaigns.ts` (new)
- `createCampaign(pool, { tenantId, agentId, name, audienceType, audienceId?, scheduledFor?, createdBy }) → CampaignRow`
  — inserts `status='draft'`. Validates the agent belongs to the tenant and is active.
- `addRecipientsFromAudience(pool, { tenantId, campaignId, audienceType, audienceId }) → { added, errors }`
  — resolves a list/segment → contacts; takes `name`/`phone` from the contact's standard fields and
  resolves each `values` key **by exact match against the contact's custom attributes** (schema
  `key` == attribute name; unmatched **required** keys produce a validation error, surfaced at
  preview/approve). Inserts recipients with a generated `suid` each; updates `recipient_count`.
- `addRecipientsFromCsv(pool, { tenantId, campaignId, rows }) → { added, errors }` — `rows` already
  parsed (see §3 CSV handling); maps columns → name/phone/values per schema.
- `validateRecipients(pool, tenantId, campaignId) → { ok, errors[] }` — flags missing phone/name and
  missing **required** `values` keys per the agent schema.
- `listCampaigns(pool, tenantId) → CampaignWithCounts[]` · `getCampaign(pool, tenantId, id)` (with
  per-status recipient counts) · `listRecipients(pool, tenantId, campaignId, { status?, limit?, offset? })`.
- `approveCampaign(pool, tenantId, id, userId) → CampaignRow` — guarded `draft→approved`; sets
  `approved_by/at`; **throws** if `validateRecipients` fails or there are zero valid recipients.
- `pauseCampaign` / `cancelCampaign` — guarded transitions (`running↔paused`, →`canceled`).
- **Worker helpers:** `claimPending(pool, limit) → RecipientRow[]` (`pending→queued`,
  `FOR UPDATE SKIP LOCKED`, only for `approved`/`running` campaigns whose `scheduled_for` is null or
  past) · `markLaunched(pool, recipientId, response)` · `markFailed(pool, recipientId, error)`
  (increments `attempts`) · `linkResultBySuid(pool, tenantId, suid, messageId, outcome) → boolean`.

`AgentRow` / `CampaignRow` / `RecipientRow` mirror their table columns.

---

## 3. Routes — `server/src/routes/callAgents.ts` + `callCampaigns.ts` (new), registered in `app.ts`

All gated `tenant_admin`/`super_admin` via `requireAdmin(requireTenantCtx(req))` (mirroring
`callAnalytics`). Zod-validated bodies. `:id` scoped to the tenant (404 if not theirs). `company_key`
is write-only and never echoed back.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/calls/agents` | Register an agent (`label`, `company_key`, `values_schema`, `default_timezone?`) |
| GET | `/api/calls/agents` | List agents (key masked) |
| PATCH | `/api/calls/agents/:id` | Update label/schema/active; rotate key |
| POST | `/api/calls/campaigns` | Create draft (`agent_id`, `name`, `audience_type`, `audience_id?`, `scheduled_for?`) |
| POST | `/api/calls/campaigns/:id/recipients` | Add recipients — from list/segment **or** CSV (multipart). Returns resolved recipients + validation errors |
| GET | `/api/calls/campaigns` | List + status counts |
| GET | `/api/calls/campaigns/:id` | Detail + recipient status breakdown |
| GET | `/api/calls/campaigns/:id/recipients` | Paginated recipients, status filter |
| POST | `/api/calls/campaigns/:id/approve` | **The send-gate:** `draft→approved` |
| POST | `/api/calls/campaigns/:id/pause` | `running→paused` |
| POST | `/api/calls/campaigns/:id/cancel` | →`canceled` |

**CSV handling:** the recipients endpoint accepts a multipart CSV upload. Columns map to
`name`/`phone` + each `values` key declared in the agent schema. The endpoint parses, maps, and
returns the resolved set with per-row validation errors (missing required → flagged). Nothing is
launched here — it only populates `draft` recipients. Approval (`/approve`) re-runs validation and
blocks on errors or zero valid recipients.

Illegal transition / bad enum / failed validation → 400; cross-tenant → 404; non-admin → 403.

---

## 4. Execution worker & the outbound→inbound loop

### 4.1 New cron `/v1/cron/process-call-queue` (`* * * * *`)
CRON_SECRET-guarded like the existing crons. Each tick:
1. `claimPending(limit)` — claims a batch of recipients belonging to `approved`/`running` campaigns
   whose `scheduled_for` is null or past (`FOR UPDATE SKIP LOCKED` → safe under concurrent ticks).
2. On first claim for a campaign, flip `approved→running`.
3. For each recipient: `getAgentForLaunch` (decrypt key), check `checkSuppressed` (§8; no-op now),
   then POST `https://dashboard-api.jobix.ai/v1/customer/save` with
   `{ company_key, customer_data: { main: { suid, name, phone, timezone }, values } }`.
4. 2xx → `markLaunched` (+`jobix_response`, `launched_at`); non-2xx/throw → `markFailed`
   (+`last_error`, `attempts++`).
5. When a campaign has no `pending`/retryable recipients left → `running→completed`.

**Retry:** recipients in `failed` with `attempts < MAX` (default 3) are re-eligible on a later tick.
Because `suid` is stable, re-POSTing `customer/save` updates the **same** Jobix customer — idempotent,
no duplicate dials. (Mirrors the existing `process-queue` / `retry-failed` split; retries can live in
the same worker by selecting `failed AND attempts < MAX` alongside `pending`.)

### 4.2 The loop-back — one additive change to `server/src/routes/v1Jobix.ts`
Jobix's result webhook posts to the existing `/v1/jobix/calls` with the same `suid` we sent (present
in the "Buyer Update Payload" sample). After the normal ingest, call
`linkResultBySuid(tenantId, suid, messageId, outcome)`:
- **Match** → set the recipient's `result_message_id` + `outcome` + `status='completed'`.
- **No match** → no-op, so inbound calls not originating from a campaign behave exactly as today.

This single hook fuses outbound and inbound into one thread and lets the campaign detail link each
recipient straight into the existing call drill-down modal.

---

## 5. Frontend — new "Outbound" area on the Calls surface

`web/src/lib/callCampaigns.ts` (typed client, same `api<T>()` pattern) + pages under `web/src/pages/`:

- **Agents manager** — list/register Jobix agents: `label`, a **write-only** `company_key` field
  (masked to last-4 after save), and a values-schema builder (rows of `key · label · required`).
- **Campaign list** — name, agent, status chip, counts (`launched/total`, outcome mix).
- **Campaign builder (draft)** — pick agent → choose source (saved list/segment **or** CSV upload) →
  **preview** resolved recipients with per-row validation (missing phone/required values flagged) →
  **Approve** (disabled until validation is clean and ≥1 valid recipient). Approve is the visible
  send-gate.
- **Campaign detail** — recipient table with status + outcome; each `result_message_id` links into
  the **existing** call drill-down modal (Slice A) — no new transcript UI.

Other Calls panels (dashboard, grid, ask-Abe, B1 worklist) are untouched.

---

## 6. Data flow

```
Admin builds campaign (agent + list/CSV → resolved recipients) → draft
Admin approves (validation passes) → approved
cron/process-call-queue: claim pending → POST customer/save (per recipient, idempotent suid) → launched
Jobix dials the customer; agent runs the call
Jobix → POST /v1/jobix/calls (existing) {suid, outcome…} → ingest + linkResultBySuid → recipient completed
Campaign detail shows outcomes; each recipient links to the existing call drill-down
```

---

## 7. Error handling

- Jobix `customer/save` non-2xx / network error → `markFailed` + `last_error` + retry to MAX, then
  terminal `failed`, surfaced per-recipient.
- Missing / undecryptable `company_key` → approval (and launch) blocked with a clear error.
- CSV/audience validation failures → rows flagged, approval blocked until clean or excluded.
- Cross-tenant `:id` → 404; non-admin → 403; approve non-draft / bad enum → 400.
- Concurrency: `FOR UPDATE SKIP LOCKED` + stable `suid` → no double-claim, no duplicate dials.

---

## 8. ⚠️ Deferred: POPIA consent / Do-Not-Call

**This slice ships bulk outbound dialing WITHOUT a consent/DNC gate, by explicit decision.** This is
a real compliance risk for outbound calling and should be the immediate fast-follow.

The data model and worker are built to accept it with **no schema change**:
- The `suppressed` recipient status already exists.
- The worker already calls `checkSuppressed(tenantId, phone)` — currently a stub returning `false`.
  A matching recipient would be set to `status='suppressed'` and never POSTed.

The later consent slice implements `checkSuppressed` against a new phone-suppression/DNC table and
adds a per-recipient consent field + a suppressed/blocked count in the approval preview.

---

## 9. Testing (Vitest, serial, Neon test branch + web build)

- **Repo:** `createAgent` encrypts the key and never leaks it; `createCampaign` draft;
  `addRecipientsFromAudience` resolves values from a list; `addRecipientsFromCsv` maps columns;
  `validateRecipients` rejects missing-required; `approveCampaign` does `draft→approved`, sets
  approver, and **rejects** empty/invalid; `claimPending` locks + transitions only eligible
  campaigns; `markLaunched`/`markFailed` (attempts); `linkResultBySuid` matches by suid.
- **Worker:** `process-call-queue` claims an approved campaign's pending recipients, POSTs (Jobix
  mocked), marks launched, completes the campaign; retries `failed < MAX`; honours `scheduled_for`;
  CRON_SECRET gate rejects unauthorized calls.
- **Routes:** agent CRUD; campaign create/recipients/approve/pause/cancel happy paths; role gate
  (non-admin → 403); cross-tenant `:id` → 404; approve-non-draft / bad enum / failed validation → 400;
  `company_key` never present in any response body.
- **Inbound loop / non-regression:** `/v1/jobix/calls` with a matching `suid` links
  `result_message_id` + `outcome` + completes the recipient; a **non-matching `suid` leaves existing
  behaviour unchanged**; existing `jobix.*`, `callAnalytics.*`, `handover.*`, `lineReport.*`, and
  email tests stay green; strict `tsc`; web build passes.

---

## 10. Out of scope (later slices)

- Consent / DNC enforcement (§8) — the immediate fast-follow.
- Pacing / throttle and calling-hours windows (Jobix handles dialing concurrency for now).
- The management agent (Abe) auto-suggesting or auto-running campaigns — the deck's autonomy tiers
  (advisory → semi-auto → fully autonomous).
- WhatsApp and email unification into one inbox; cross-channel analytics rollup; single billing.
- Surfacing outbound campaigns inside B1's cross-call worklist.
