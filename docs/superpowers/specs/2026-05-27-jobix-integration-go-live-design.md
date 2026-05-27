# Jobix Integration & Go-Live — Design Spec

**Date:** 2026-05-27
**Status:** Approved (brainstorm), pending implementation plan
**Approach:** B — Harden-then-wire

## Goal

Make `POST /v1/emails` safe and easy to drive from a Jobix custom-integration webhook,
then validate the whole send path live and put it on a branded domain. The send core,
SMTP/dispatch, cron, webhooks, tenancy, and admin UI already exist and work — this is a
hardening + ops layer around them, not a rebuild.

## Context (as found)

- App is deployed on Vercel under the **Regalis** team (`prj_Fy2ljIIH4GTsJ4so05h8NgxrhlY4`),
  reachable at `https://aiployee-emailer.vercel.app` (`/healthz` → `200 {"ok":true}`).
  It had been returning `402 DEPLOYMENT_DISABLED`; the project was transferred to Regalis and
  is live again. (The README's standing "🟢 Live" claim should be treated as needing periodic
  re-verification.)
- Admin UI already exists and covers the operator needs: add tenants (`AdminTenants.tsx`),
  add senders (`Senders.tsx`), generate per-tenant API keys (`ApiKeys.tsx`), manage SMTP
  configs (`SmtpConfigs.tsx`, now with a Gmail App-Password preset).
- API keys are currently **tenant-scoped only** (`api_keys.tenant_id`); any key can send as any
  registered sender of the tenant.
- Auth accepts the key **only** as `Authorization: Bearer <key>` (`auth/ctx.ts`).
- `POST /v1/emails` has **no idempotency** — a retried webhook re-sends.
- Send input schema lives in `send/pipeline.ts` (`SendInputShape`), snake_case public fields.

## Non-goals (YAGNI for this round)

- Hosted "copy config into Jobix" setup page, delivery callbacks back into Jobix, metrics
  dashboard (Approach C).
- Per-key rate limiting — **deferred** to a fast-follow. Vercel provides platform DDoS
  protection and the throughput ceiling is the tenant's SMTP, not us. Revisit if abuse appears.

---

## 1. Flexible API-key auth (`auth/ctx.ts`)

Resolve the API key from the first present header, in precedence order:

1. `api_key: aip_live_…` (raw key — matches Jobix's default header field)
2. `X-Api-Key: aip_live_…` (raw key — common convention)
3. `Authorization: Bearer aip_live_…` (existing; backward-compatible)

The resolved raw key is hashed (`sha256`, unchanged) and looked up exactly as today. Missing
or unmatched → `401 unauthorized`. The key value must never be logged.

The auth lookup `RETURNING` clause additionally returns `sender_id` so the resolved `Ctx` carries
`boundSenderId` (see §2), avoiding a second query on the send path.

## 2. Per-key sender binding (optional, default tenant-wide)

**Model:** an API key is either tenant-wide or bound to one sender.

- `sender_id = NULL` → **tenant-wide**: may send as any registered sender; the request `from`
  selects which. (Existing behavior; all current keys remain tenant-wide.)
- `sender_id` set → **sender-bound**: may only send as that one address. If `from` is omitted it
  defaults to the bound sender's email; any other `from` → `422 invalid_sender`.

This satisfies "distribute per client" (client = tenant; each tenant has its own revocable keys)
while handling "two addresses in one tenant" with a single tenant-wide key, and offers locked-down
keys when blast-radius control is wanted.

**UI:** the API Keys page gets an optional "Restrict to sender" dropdown (default "Any sender").

## 3. Idempotency (both strategies)

Applied before queue/dispatch in `v1Emails.ts`; threaded through `queueEmail`.

- **Explicit (authoritative):** request header `Idempotency-Key: <caller-unique string>`.
  Look up `(tenant_id, idempotency_key)`. Hit → return the stored result with `200` (no re-send).
  Miss → insert with the key. Concurrent retries are resolved by a partial unique index +
  `ON CONFLICT`: the loser re-selects and returns the stored result as `200`.
- **Fallback (best-effort):** when no `Idempotency-Key` is supplied, compute
  `dedupe_hash = sha256(tenant_id | from | to | cc | bcc | subject | html | text | template | variables)`.
  If a row with the same hash for this tenant exists within the window (`IDEMPOTENCY_WINDOW_MIN`,
  default 10), return that row as `200`. Otherwise proceed and store the hash. A deliberate identical
  resend after the window still sends.

Replays never re-dispatch; they return the original row's current status.

## 4. Stable error model

Errors keep the existing envelope `{ "error": { "code", "message" } }`. The send route maps to a
fixed, documented set so a Jobix branch step can switch on `code`:

| HTTP | code | when |
|---|---|---|
| 401 | `unauthorized` | missing/invalid key |
| 422 | `invalid_sender` | `from` not a registered sender / violates a sender-bound key |
| 422 | `validation_error` | body fails schema (neither subject+html nor template; bad email) |
| 404 | `template_not_found` | named template missing for tenant |

Success contract is unchanged: `202 { id, status: sent|failed|queued|suppressed, message_id, error }`.
A **suppressed recipient is not an error** — it returns `202` with `status: "suppressed"` (current
behavior, kept). Idempotent replay returns `200` with the stored result (lets Jobix distinguish
replay from fresh accept).

> Migration note: today `invalid_sender` returns `400`; remapping to `422` is part of this work.
> The success contract (including `suppressed` as a status) does not change.

## 5. Data model — one additive migration

**`emails`:**
- `idempotency_key text NULL`
- `dedupe_hash text NULL` (set on every insert)
- partial unique index `UNIQUE (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL`
- lookup index `(tenant_id, dedupe_hash, created_at) WHERE dedupe_hash IS NOT NULL`

**`api_keys`:**
- `sender_id uuid NULL REFERENCES senders(id)` with **`ON DELETE RESTRICT`** — deleting a sender that
  still has bound keys is blocked with a clear error, so a locked-down key can never silently become
  tenant-wide. Operator must revoke/rebind first.

## 6. Jobix custom-integration mapping

Maps onto Jobix's webhook config screen (URL / Method / Headers / Payload Fields). Full field
reference lives in `payload-fields.md` (repo root).

- **URL:** `https://<branded-domain>/v1/emails` · **Method:** `POST`
- **Headers:** `api_key: aip_live_…`, `Content-Type: application/json`,
  `Idempotency-Key: <Jobix run/execution id>` (makes Jobix's own retries safe)
- **Payload Fields:** JSON body — `from`, `to`, `subject`, `html` (or `template` + `variables`),
  optional `cc`/`bcc`/`reply_to`/`text`/`attachments`/`scheduled_for`. With a sender-bound key,
  `from` may be omitted.
- **Branching:** on `status` (`sent`/`failed`/`queued`/`suppressed`) and `error.code`.

## 7. Go-live

**7a. Re-enable deployment — DONE.** Project transferred to Regalis; `/healthz` green.

**7b. End-to-end validation** (extends `docs/acceptance/README.md`, evidence recorded per item):
1. **First real send via Gmail:** tenant with sender `liam@aiployee.co.za`, Gmail SMTP config
   (App Password, 2-Step Verification on), send → recipient receives; row `queued → sent`.
2. cron-job.org firing both `/v1/cron/*` jobs (`200 {ok:true}`; `CRON_SECRET` set).
3. Scheduled send arrives at the right minute.
4. Bounce webhook (SES or Mailgun) marks an email `bounced` + adds to suppressions.
5. Second-tenant isolation — tenant A cannot see/send-as tenant B.
6. **Idempotency:** same `Idempotency-Key` twice → one email, second call `200` replay; content-hash
   fallback dedupes a keyless retry within the window; sender-bound key rejects a foreign `from`.

**7c. Custom domain:** move off `*.vercel.app` to a branded host (placeholder
`emailer.aiployee.co.za` — confirm). Add domain in Vercel, DNS CNAME, update `PUBLIC_BASE_URL`,
repoint cron-job.org URLs, re-issue the Jobix webhook URL.

**7d. Ops / alerting (free-tier friendly):**
- `/healthz` uptime monitor alerting on non-200 (catches a future `DEPLOYMENT_DISABLED`).
- A threshold check on `failed` emails so silent SMTP failures surface.
- Audit log lines to confirm API keys and SMTP passwords are never logged.
- Alert channel: **TBD — confirm** (placeholder `liam.p@regalis.co.za`).

## 8. Testing & security

- **Unit:** auth header resolution (all three sources + precedence + miss); idempotency (explicit hit/miss,
  race via ON CONFLICT, content-hash window hit/miss); sender-binding enforcement (omitted `from` defaults,
  foreign `from` rejected); error-code mapping.
- **Migration:** up/down; index presence; RESTRICT on sender delete with bound key.
- **Security review (auth touched):** key never logged; binding can't be bypassed; idempotency lookups are
  tenant-scoped (no cross-tenant replay leakage); `ON CONFLICT` can't leak another tenant's row.
- **Backward compatibility:** existing `Authorization: Bearer` callers and all current tenant-wide keys
  keep working unchanged.

## Open items to confirm during planning

1. Branded domain name (default `emailer.aiployee.co.za`).
2. Alert channel for ops (default `liam.p@regalis.co.za`).
3. Whether to keep rate-limiting deferred (current decision: yes, defer).
