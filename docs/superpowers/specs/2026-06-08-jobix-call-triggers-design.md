# Jobix Call Triggers — Design

**Date:** 2026-06-08
**Status:** Design approved (pending spec review)
**Scope:** A reusable "fire a Jobix call" primitive driven by Jobix's new **webhook-trigger node**
(`POST https://dashboard-api.jobix.ai/automation/trigger/webhook`), configured on the Webhooks page,
with a manual test/fire flow and a fire log. The first composable building block of the agentic-comms
dashboard (the pitch deck's Command Centre).

---

## 0. Why

Jobix added a **webhook-trigger node** for calls: a tenant builds an automation in Jobix that starts
with a token-authenticated webhook and ends with a call, generates a token in Jobix, and copies it
out. Our app becomes the **caller** that POSTs to the trigger to launch a call.

The goal is not just to store config — it is to make the Webhooks tab **actually fire calls** off the
back of things happening in the app (email-campaign reactions today; Abe's suggestions tomorrow —
*"these 10 customers were unhappy, call them back with an agent who can fix it"*). So this slice
builds a clean, reusable **`fireTrigger` primitive** plus a manual UI to prove it, designed from day
one to be called by an event rule, by Abe, or by a future flow-builder node.

### 0.1 Where this sits (the bigger picture)

This is **brick A** of the agentic-comms dashboard, decomposed as:

| # | Sub-project | Status |
|---|---|---|
| A | **Channel actions** — email send ✅, voice via `customer/save` ✅, **voice via Jobix webhook-trigger ← this slice**, WhatsApp ⛔ (blocked on Renier's API) |
| B | Uniform "comms action" abstraction (fire channel X at customer Y with context Z) | later |
| C | Flow builder (visual multi-step, multi-channel) + execution engine | later |
| D | Abe orchestration (suggest/drive flows) | later |
| E | Dashboard shell | later |

This slice delivers a working channel action and the shape a flow node will reuse. It is **isolated**
from the existing `call_agents`/`customer/save` campaign path — a separate, additive transport, no
regression risk.

## 0.2 Non-negotiable constraints

- **Additive / no regression:** two new tables, one new repo, one new primitive, one new route module,
  a new section on the existing Webhooks page. `call_agents`/`call_campaigns`, the email path, and the
  existing event-webhooks all untouched.
- **Role gating:** every new route is `tenant_admin` OR `super_admin` (the local `requireAdmin`
  pattern used across the app).
- **Secret hygiene:** the Jobix token is stored encrypted (`crypto/enc.ts`, AES-256-GCM, `app.cfg.encKey`)
  and is **never** returned to any client (only a `hasToken` flag).

## 0.3 Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Role of the trigger | A reusable "fire a call" primitive (config + server action + manual fire); the first flow-builder node |
| Data shape | A per-tenant **registry** — many triggers per tenant, label-keyed |
| Request contract | **Configurable**: token placement (bearer/header/query/body) + a JSON payload **template** with `{{placeholders}}`, dialed in via a **Send test** button |
| Debugging | Keep a lightweight **fire log** (`jobix_trigger_fires`) |
| Surface | A new section on the existing **Webhooks page** (`EventWebhooks.tsx`) |
| Isolation | Separate from `call_agents`/`customer/save`; additive |

---

## 1. Data model — migration `1700000000032_jobix_triggers.cjs`

Two new tables, additive. (031 = `call_campaigns`, already on master.) **Migration number:** the
still-unbuilt B1 `call_actions` design also targets the next free number. Neither is built; **whichever
ships first takes `032`, the other `033`.** This spec assumes Jobix Call Triggers ships first; if B1
lands first, renumber this migration to `033` (no other change).

### 1.1 `jobix_triggers` — per-tenant registry (many per tenant)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | `gen_random_uuid()` |
| `tenant_id` | uuid notNull → tenants | CASCADE |
| `label` | text notNull | e.g. "Unhappy-customer callback". Unique `(tenant_id, label)` |
| `url` | text notNull | default `https://dashboard-api.jobix.ai/automation/trigger/webhook` |
| `token_encrypted` | bytea notNull | Jobix token, encrypted. Never returned to client |
| `token_placement` | text notNull default `'bearer'` | check `IN ('bearer','header','query','body')` |
| `token_param` | text | header name / query key / body field; ignored for `bearer` |
| `payload_template` | text notNull default `'{}'` | JSON text with `{{placeholders}}` |
| `active` | boolean notNull default `true` | |
| `last_fired_at` | timestamptz | |
| `created_by` | uuid → users (SET NULL) | |
| `created_at` / `updated_at` | timestamptz notNull default now() | |

Indexes: unique `(tenant_id, label)`, `(tenant_id)`.

### 1.2 `jobix_trigger_fires` — fire log (debugging + seed of the dashboard activity view)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `tenant_id` | uuid notNull → tenants | CASCADE |
| `trigger_id` | uuid notNull → jobix_triggers | CASCADE |
| `source` | text notNull default `'manual'` | check `IN ('manual','test','event','abe')` — who fired it |
| `vars` | jsonb notNull default `'{}'` | the substituted variables |
| `http_status` | integer | response status (null on network error) |
| `ok` | boolean notNull | overall success (2xx and no error) |
| `response_snippet` | text | truncated response body (≤ 2000 chars) |
| `error` | text | failure reason (≤ 2000 chars) |
| `created_by` | uuid → users (SET NULL) | |
| `created_at` | timestamptz notNull default now() | |

Indexes: `(tenant_id, created_at DESC)`, `(trigger_id)`.

### 1.3 Token placement → request

| `token_placement` | Effect |
|---|---|
| `bearer` | header `Authorization: Bearer <token>` (`token_param` ignored) |
| `header` | header `<token_param>: <token>` |
| `query` | append `?<token_param>=<token>` (or `&…` if the url already has a query) |
| `body` | set top-level key `<token_param>` = `<token>` on the parsed JSON body |

---

## 2. Fire primitive — `server/src/jobix/fireTrigger.ts` (new)

```
fireTrigger(pool, encKey, { tenantId, triggerId, vars, source, userId? }) → FireResult
```

`vars: Record<string, string>` — caller-agnostic (manual form passes `{name, phone, context}`;
events/Abe pass whatever they have).

`FireResult = { ok: boolean; httpStatus: number | null; responseSnippet: string | null; error: string | null; renderedPayload: string; unresolved: string[] }`

**Steps:**
1. `getTriggerForFire(pool, encKey, tenantId, triggerId)` (tenant-scoped, decrypts token). Null → throw
   `AppError('not_found', 404)`.
2. Require `active` **unless** `source === 'test'` (test can fire a disabled trigger for debugging).
   Inactive + non-test → throw `AppError('trigger_inactive', 400)`.
3. **Render payload:** replace each `{{key}}` in `payload_template` with the JSON-string-escaped value
   of `vars[key]` — escaped via `JSON.stringify(value).slice(1, -1)` so quotes/newlines can't break the
   JSON (placeholders are assumed to sit in JSON **string** positions, e.g. `"phone":"{{phone}}"`).
   Any `{{key}}` with no matching var → replaced with empty string and added to `unresolved[]`
   (reported, non-fatal). Then `JSON.parse` the result; on failure return
   `{ ok:false, error:'invalid_payload', renderedPayload, httpStatus:null, … }` (still logged).
4. **Apply token placement** (§1.3) to build headers / final url / body object.
5. POST `application/json` with an 8s `AbortController` timeout (same pattern as the existing
   event-webhook delivery). Capture status + truncated body; network/timeout → `ok:false`, `httpStatus:null`,
   `error` = the message.
6. `recordFire(...)` a `jobix_trigger_fires` row (source, vars, http_status, ok, response_snippet, error,
   created_by) and `touchLastFired(triggerId)`.
7. Return the `FireResult`.

**Templating note (v1 known limitation):** placeholders in non-string JSON positions
(`"count": {{n}}`) are not special-cased; a malformed result surfaces as a clear `invalid_payload`
error, not a silent bug. Documented, not hidden.

Separation of concerns: the **repo** does persistence/crypto, **`fireTrigger`** does templating + HTTP
+ logging, **routes** are thin wrappers. Events/Abe/flow-nodes call `fireTrigger` directly (not over
HTTP).

---

## 3. Repo — `server/src/repos/jobixTriggers.ts` (new)

- `createTrigger(pool, key, { tenantId, label, url?, token, tokenPlacement, tokenParam?, payloadTemplate, createdBy? }) → TriggerPublic`
  — validates the url (§5), encrypts the token, defaults url to the Jobix endpoint. Returns public (no token).
- `listTriggers(pool, tenantId) → TriggerPublic[]` — `hasToken: true`; token never included.
- `getTriggerForFire(pool, key, tenantId, id) → TriggerForFire | null` — server-only, decrypts the token.
- `updateTrigger(pool, key, tenantId, id, patch) → TriggerPublic | null` — label/url/token rotation/
  placement/param/template/active; re-validates url if changed.
- `deleteTrigger(pool, tenantId, id) → boolean`.
- `recordFire(pool, { tenantId, triggerId, source, vars, httpStatus, ok, responseSnippet, error, createdBy }) → void`.
- `listFires(pool, tenantId, triggerId, { limit?, offset? }) → { fires: FireRow[]; total: number }`.
- `touchLastFired(pool, id) → void`.

`TriggerPublic` mirrors the columns minus `token_encrypted`, plus `hasToken: true`. Every query is
tenant-scoped.

---

## 4. Routes — `server/src/routes/jobixTriggers.ts` (new), registered in `app.ts`

All gated `tenant_admin`/`super_admin` via the local `requireAdmin(requireTenantCtx(req))` pattern.
Zod-validated. `:id` tenant-scoped (404). Token write-only (never echoed).

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/jobix-triggers` | Create (`label`, `url?`, `token`, `token_placement`, `token_param?`, `payload_template`) |
| GET | `/api/jobix-triggers` | List (token masked) |
| PATCH | `/api/jobix-triggers/:id` | Update / rotate token / toggle active |
| DELETE | `/api/jobix-triggers/:id` | Remove |
| POST | `/api/jobix-triggers/:id/test` | `{ vars }` → `fireTrigger(source:'test')` → full `FireResult` |
| POST | `/api/jobix-triggers/:id/fire` | `{ vars, source? }` → `fireTrigger(source:'manual')` (requires active) → `FireResult` |
| GET | `/api/jobix-triggers/:id/fires` | Recent fire log (paginated) |

Validation: `token_placement` enum; when not `bearer`, `token_param` required (400 otherwise);
`url` validated per §5; `payload_template` must be a non-empty string (JSON validity is checked at
fire time, surfaced as `invalid_payload`).

---

## 5. Security / SSRF

- **Token:** encrypted at rest (`crypto/enc.ts`), write-only, rotation supported, never returned
  (`hasToken` only).
- **Access:** all routes admin-gated + tenant-scoped.
- **URL validation (`validateTriggerUrl`)** — applied on create/update:
  - scheme **must be `https:`** (reject `http:` and anything else);
  - **reject** hostnames that are `localhost`, or literal private/link-local/metadata IPs:
    `127.*`, `10.*`, `192.168.*`, `172.16–31.*`, `169.254.*`, `0.0.0.0`, `::1`.
  - Default url is the Jobix endpoint.
  - **Tracked follow-up:** full SSRF hardening (DNS-resolution / rebinding checks) — acceptable to
    defer because the surface is admin-only (trusted internal roles).
- **PII / logging:** `jobix_trigger_fires.vars` + `response_snippet` hold the tenant's own data;
  response truncated to ≤ 2000 chars. `query` placement puts the token in the URL — the UI hint flags
  this as the tenant's choice.

---

## 6. Frontend — Webhooks page

Extend `web/src/pages/EventWebhooks.tsx` into a two-section **"Webhooks"** page: the existing email
event-webhooks card unchanged; a new **"Jobix Call Triggers"** card beneath it. New typed client
`web/src/lib/jobixTriggers.ts` (same `api<T>()` pattern). Nav already points here — no new route.

**Jobix Call Triggers card:**
- **Triggers table:** label · url (truncated) · placement · active · last fired · actions.
- **Create/edit form:** `label`; `url` (prefilled to the Jobix endpoint); `token` (write-only, shows
  `•••••••••• (set)` when saved); `token_placement` select (Bearer / Custom header / Query param /
  Body field); `token_param` (shown only when placement ≠ bearer); `payload_template` (JSON textarea
  with a hint listing `{{name}}`, `{{phone}}`, `{{context}}` + note that programmatic callers can pass
  custom keys); `active` toggle.
- **Test action:** a small form (name / phone / context) → `POST /test` → shows the `FireResult`
  inline (HTTP status, response snippet, rendered payload, unresolved placeholders). The dial-it-in
  loop against real Jobix.
- **Trigger now action:** same form → `POST /fire` (requires active).
- **Fire log:** "View log" per trigger → recent fires (source, status, time, response/error).

Other pages untouched.

---

## 7. Data flow

```
Admin builds the automation in Jobix → generates a token → pastes token + payload template into our Webhooks page
Admin clicks Test (name/phone/context) → POST /test → fireTrigger(source:test) → POST to Jobix → FireResult shown inline
  ↳ iterate token placement / template until the response is green
Admin clicks Trigger now → POST /fire → fireTrigger(source:manual) → call launched → logged
Later: an email-event rule / Abe / a flow node calls fireTrigger(source:event|abe) directly with its own vars
```

---

## 8. Error handling

- Rendered payload not valid JSON → `FireResult.ok=false, error='invalid_payload'` (+ rendered text), logged.
- Network error / timeout → `ok=false`, `httpStatus=null`, error message, logged.
- Non-2xx from Jobix → `ok=false`, status + snippet, logged.
- Fire on inactive (non-test) → 400 `trigger_inactive`.
- Cross-tenant `:id` → 404; non-admin → 403; bad enum / missing `token_param` / invalid url → 400.
- Token missing/undecryptable → surfaced as an error (not a crash).

---

## 9. Testing (Vitest, serial, Neon test branch + web build)

- **Repo:** `createTrigger` encrypts token & never returns it (+ url validation); `listTriggers` masks;
  `getTriggerForFire` decrypts; `updateTrigger` rotates token / toggles active / re-validates url;
  `deleteTrigger`; `recordFire`/`listFires`; cross-tenant `getTriggerForFire` → null.
- **`fireTrigger` primitive (fetch stubbed via `vi.stubGlobal` — never hits real Jobix):** template
  renders with escaping; each `token_placement` produces the right header/url/body (asserted on the
  stub's call args); `invalid_payload` on malformed render; a fire row is written + `last_fired_at`
  set; `test` bypasses `active`; unresolved placeholders reported; network failure → `ok=false` logged.
- **Routes:** CRUD happy paths; `/test` + `/fire` return `FireResult` (stubbed fetch, **no real call**);
  403 non-admin; 404 cross-tenant; 400 fire-inactive / bad-url / missing token_param; token never in any
  response body; fires-log endpoint returns rows.
- **Security:** `validateTriggerUrl` rejects `http://` and `localhost`/private-IP literals; accepts the
  Jobix https url.
- **Non-breakage:** existing `eventWebhooks*` tests + full suite green; strict `tsc`; web build passes.

---

## 10. Out of scope (later slices)

- Event-driven rules (email-campaign action → auto-fire a trigger).
- Abe identifying cohorts and proposing/firing call-backs.
- The flow builder + execution engine and the uniform comms-action abstraction (bricks B–E).
- WhatsApp channel (blocked on Renier's API).
- Full SSRF hardening (DNS-resolution / rebinding checks) — §5.
- Non-string-position templating (typed placeholders) — §2.
