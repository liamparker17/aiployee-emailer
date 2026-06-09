# AIployee Segmentation — Phase 1: The Seam

**Date:** 2026-06-08
**Status:** Design approved (verbal), pending written review
**Author:** Liam + Claude (brainstorming session)

---

## 1. Background & Motivation

This repository began life as "the emailer" and grew, unplanned, into a multi-tenant,
multi-channel platform. Today it contains three intermixed concerns:

- A genuine **email-marketing product** (senders, campaigns, templates, send pipeline).
- A **cross-channel command-centre** (Abe the AI manager/analyst, calls, dashboard, flows).
- A **shared platform backbone** (auth, multi-tenancy, contacts/CRM, suppressions) that
  both of the above depend on.

The AIployee product vision (per `AIployee_Products_Deck.pdf`) is an **omnichannel AI
workforce** with four products — Agentic **Voice** (Jobix), Agentic **WhatsApp** (a
colleague's separate app), Agentic **Email** (this repo), and the **Command Centre** (the
"hero": one login, one inbox, one AI manager over every channel).

The problem: the Command Centre is currently *fused into the emailer*. To make each product
"its own thing" — and to let the Command Centre federate across channels — we must segment
this codebase along clean boundaries.

## 2. Decisions Already Made (this session)

1. **Carve direction:** Email is lifted into its own app; the command-centre concerns become
   their own app. (Conceptually "this repo becomes the CC" — but see #2 for the mechanics.)
2. **Email URL is sacred:** the email app must keep `aiployee-emailer.vercel.app`. This is the
   `.vercel.app` alias of Vercel project `aiployee-emailer` (`prj_Fy2ljIIH4GTsJ4so05h8NgxrhlY4`,
   team Regalis). There is **no portable custom domain** — the alias follows the project, the
   project follows this repo. ⇒ The email app keeps the existing Vercel project untouched; the
   Command Centre gets a **new** Vercel project/URL.
3. **Shared backbone, not federation:** all products share **one Neon DB + one identity**. The
   Command Centre *owns* the backbone — contacts/conversations from any channel land in the
   shared store and are instantly visible everywhere. "One login, one inbox" is therefore mostly
   free (the CC queries the same tables email/calls write).
4. **Repo topology — Option 2 (monorepo, two deployables):** one repo, evolved into
   `packages/*` + `apps/email` + `apps/command-centre`, with Vercel deploying two projects from
   the one repo via different Root Directories. WhatsApp (colleague) and Voice (Jobix) remain
   separate repos and federate via the shared DB.
5. **Two agents, not one:** the email **reply agent** ("reads & replies" to inbound email) stays
   with the email product; **Abe** the cross-channel *manager/analyst* belongs to the Command
   Centre.
6. **Contacts + suppressions live in the backbone** (`core`), so people/consent gathered from
   any channel are shared.
7. **Email must be fully usable standalone** (light dashboard + login + audience picker, all
   served off the backbone) — per the deck's "pick one product, prove ROI standalone."
8. **Two shared packages:** `@aiployee/core` (backend backbone) + `@aiployee/ui` (shared
   frontend), rather than one mega-package. Existing `@aiployee/shared` (types) is kept.
9. **Migrations:** `core` owns backbone-table migrations; each app owns its own table
   migrations; all run against the single shared Neon DB.
10. **Command Centre URL:** new Vercel project `aiployee-command-centre` →
    `aiployee-command-centre.vercel.app`.
11. **Cross-app login = token-handoff SSO, built in Phase 1.** Because both apps share the one
    `tenants`+`users` table, the *same account* already authenticates on both. To avoid a second
    login, a user navigating emailer↔dashboard carries a short-lived signed handoff token
    (HMAC over user+tenant+expiry, keyed by the shared `SESSION_SECRET`); the receiving app
    verifies it against the shared DB and mints its own session. This works on the current
    `*.vercel.app` subdomains (which cannot share a cookie — `vercel.app` is on the Public Suffix
    List). Shared-cookie SSO under a common `*.aiployee.co.za` parent is the eventual Phase 4
    replacement once custom domains exist.

## 3. Program Decomposition (the whole road)

Each phase gets its own spec → plan → build cycle. **This spec covers Phase 1 only.**

- **Phase 1 — The Seam (THIS SPEC):** restructure into `packages/core` + `packages/ui` +
  `apps/email` + `apps/command-centre`; move code to the right side of the boundary; split the
  deploy. No new user-facing features.
- **Phase 2 — Command Centre v1:** stand up `apps/command-centre` as its own deploy — login on
  the backbone, cross-channel dashboard, Abe's home, v1 unified inbox over existing email+call
  data.
- **Phase 3 — Federation:** wire the colleague's WhatsApp and Jobix's voice contacts/
  conversations into the shared backbone so they surface in CC inbox/analytics.
- **Phase 4 — Packaging:** per-product billing/tiers, SSO/cross-app linking, "scales with you"
  features.

## 4. Goals & Non-Goals (Phase 1)

**Goals**
- One monorepo evolves into `packages/core`, `packages/ui`, `packages/shared`, `apps/email`,
  `apps/command-centre`.
- Hard, enforced import boundaries: `core` depends on nobody; `email` and `command-centre`
  depend on `core`/`ui`/`shared` but **never on each other**.
- The email app continues to deploy to `aiployee-emailer.vercel.app` with its env vars, Neon
  wiring, and behaviour **unchanged**.
- The command-centre app is independently deployable to a new Vercel project/URL against the
  same Neon DB.
- Test suite green at every step (Vitest serial against the Neon `test` branch).

**Non-Goals (Phase 1)**
- No new features, no UI redesign, no new dashboard.
- No data migration / table restructuring (same shared DB, same tables).
- No WhatsApp/Jobix federation work.
- No *shared-cookie* SSO / custom domains (Phase 4). Phase 1 **does** include **token-handoff
  SSO** (decision #11) so a logged-in tenant moves emailer↔dashboard without re-authenticating.

## 5. Target Repository Layout

```
packages/
  shared/         @aiployee/shared  — existing shared types/zod (kept; may absorb cross-cutting types)
  core/           @aiployee/core    — backend backbone (see §6)
  ui/             @aiployee/ui       — shared React: auth context, api client, design-system components
apps/
  email/
    server/       Fastify app: email routes only        api/index.ts   vercel.json (email crons)
    web/          Vite SPA: email pages + standalone shell, built to apps/email/server/public
  command-centre/
    server/       Fastify app: CC routes only            api/index.ts   vercel.json (CC crons)
    web/          Vite SPA: CC pages, built to apps/command-centre/server/public
```

Each app preserves today's deploy pattern exactly (one Fastify function serving its API +
its own Vite SPA built into its own `public/`, SPA catch-all rewrite) — there are simply two
of them. Root build commands fan out per app.

## 6. Module Allocation

> The lists below are the current `server/src/*` and `web/src/*` inventory mapped to a bucket.
> Items marked **(OPEN)** are genuinely ambiguous and MUST be resolved explicitly during the
> writing-plans step rather than hand-waved.

### → `packages/core` (backend backbone)
- `db/pool.ts`
- `auth/*` — `session.ts`, `password.ts`, `apiKey.ts`, `csrf.ts`, `ctx.ts`
- `crypto/enc.ts`
- `util/*` — `logger.ts`, `errors.ts`
- repos: `tenants.ts`, `users.ts`, `apiKeys.ts`, `contacts.ts`, `contactLists.ts`,
  `segments.ts`, `suppressions.ts`
- routes that are pure platform: `auth.ts`, `session.ts`, `users.ts`, `adminTenants.ts`,
  `apiKeys.ts`
- `bin/createAdmin.ts`
- The conversations/email-events spine that becomes "one inbox": `repos/emailEvents.ts` is the
  current seed of this. **(OPEN: does `emailEvents` stay email-only or become the core
  conversations store? Leaning core, as the inbox spine.)**

### → `apps/email` (Agentic Email product)
- routes: `senders.ts`, `smtpConfigs.ts`, `domains.ts`, `campaigns.ts`, `marketing.ts`,
  `templates.ts`, `emails.ts`, `analytics.ts`, `track.ts`, `v1Emails.ts`, `v1Webhooks.ts`,
  `suppressions.ts` (route surface; repo lives in core)
- repos: `senders.ts`, `smtpConfigs.ts`, `sendingDomains.ts`, `campaigns.ts`, `templates.ts`,
  `emails.ts`
- `send/*` — `sender.ts`, `render.ts`, `tracking.ts`, `dispatch.ts`, `pipeline.ts`
- `marketing/*` — `campaignSend.ts`, `unsubscribe.ts`
- `webhooks/mailgun.ts`, `webhooks/ses.ts`
- the **email reply agent** (the inbound-reply responder — subset of today's agent code)
- crons: `process-queue`, `retry-failed`

### → `apps/command-centre` (the hero)
- `agent/abe/*` (all of it) + `agent/runner.ts`, `agent/webhook.ts`
- routes: `abe.ts`, `agentChat.ts`, `agent.ts`, `callHandovers.ts`
- repos: `agent.ts`, `agentApprovals.ts`, `agentChat.ts`, `agentDormant.ts`, `agentEligible.ts`,
  `agentGoals.ts`, `agentOutcomes.ts`, `agentPlays.ts`, `lineCallTags.ts`, `lineReports.ts`,
  `callHandovers.ts`
- calls / call campaigns / line reporting / handovers / flows / jobixTriggers
  (web: `Calls`, `CallCampaigns`, `Flows`, `JobixBuilder`; server counterparts)
- cross-channel `Dashboard`
- crons: `abe-shift`, `abe-touches`, `abe-outcomes`, `line-report`, `abe-handovers`,
  `process-call-queue`, `process-flows`

### OPEN allocations (resolve in plan)
- **`eventWebhooks` / `eventDelivery`** — generic *outbound* event webhooks to customers. Core
  platform feature, or email-specific? (Leaning core, exposed to both apps.)
- **`mcpServers` + RAG providers** (`ragSqlProvider`, `ragVectorProvider`, `ragDocuments`,
  `ragSqlSources`) — which agent consumes them? If only Abe → command-centre; if the email reply
  agent also uses RAG → core (shared agent infra).
- **`segments`** — pure CRM (→ core) but verify it doesn't depend on email-events in a way that
  drags email coupling into core.
- **`emailEvents`** — email-only vs the core conversations spine (see above).

## 7. Boundary Enforcement

- Each app's `package.json` declares dependencies on `@aiployee/core`, `@aiployee/ui`,
  `@aiployee/shared` only.
- Add a CI/lint guard that **fails the build** on any import crossing `apps/email ↔
  apps/command-centre`, or from `core` into any app. (e.g. an `eslint-plugin-import` / dependency-
  cruiser rule, or a small custom check.) This is what keeps the seam from silently re-fusing.

## 8. Deploy Split & URL Preservation

- **Email app:** keep the existing Vercel project `aiployee-emailer` entirely. Only change its
  **Root Directory** to `apps/email` and trim `vercel.json` to the email crons + the email
  function/rewrites. Env vars, Neon connection, and the `aiployee-emailer.vercel.app` alias are
  untouched.
- **Command Centre app:** create a **new** Vercel project (Root Directory `apps/command-centre`),
  new URL (e.g. `aiployee-command-centre.vercel.app`), pointed at the **same** Neon DB
  (`lingering-fire-63783363`), carrying the CC crons.
- The Neon prod-migration-before-deploy discipline (expand pattern) continues to apply to both.

## 9. Migrations Strategy (the tricky bit)

All 34 existing migrations live in one `server/migrations/` directory with **interleaved**
timestamps — backbone, email, and CC migrations are chronologically mixed (e.g. `…0001` tenants,
`…0019` campaigns, `…0021` abe, `…0033` flows). They have already run against prod, so we do
**not** re-partition history.

Approach:
- **Freeze existing history.** The 34 applied migrations stay as the immutable baseline. We do
  **not** split or rewrite them.
- **Going forward**, new migrations are authored in the package/app that owns the table:
  backbone-table changes → `packages/core/migrations`, email-table changes → `apps/email/migrations`,
  CC-table changes → `apps/command-centre/migrations`.
- A single `node-pg-migrate` invocation per deploy must apply across all three migration dirs
  against the one DB **in a deterministic global order**. Options to decide in the plan:
  (a) keep one shared `migrations/` dir in `core` that everything appends to (simplest, weakest
  ownership), or (b) multiple dirs with a combined ordering driven by timestamp prefixes and a
  wrapper migrate script. **Leaning (a) for now** — one shared migrations dir in `core`, since the
  DB is shared and a single ordered ledger is least error-prone; revisit if ownership friction
  appears.

## 10. Sequencing (always-green)

1. **Create `packages/core` + `packages/ui`**, move backbone + shared-UI code into them, and make
   today's single `server`/`web` import from them. Deploy unchanged — nothing user-visible moves.
   Tests green.
2. **Split the server** into `apps/email/server` + `apps/command-centre/server` within the repo,
   both buildable/deployable locally. Split `web` similarly. Tests green.
3. **Re-point** the existing Vercel project's Root Directory to `apps/email`; **create** the CC
   Vercel project for `apps/command-centre`. Verify both deploy; email URL + healthz unchanged.
4. **Add the boundary-enforcement guard** and confirm CI fails on a deliberate cross-import.

## 11. Testing & Verification

- Vitest runs **serially** against the Neon `test` branch (existing constraint — never run two
  suites at once on the shared branch).
- After each sequencing step: `npm test` green.
- After deploy split: poll the email deployment to `READY` (Vercel MCP), `curl
  https://aiployee-emailer.vercel.app/healthz` (expect 200), confirm served asset hash matches the
  local `apps/email/web` build; then the same for the new CC URL.

## 12. Risks & Mitigations

- **Breaking the live email deploy.** Mitigation: staged sequencing keeps the existing app
  deployable until the very last re-point step; the Vercel project itself is never recreated, only
  its Root Directory changes; recent prod deploys are rollback candidates.
- **Hidden coupling** between email and CC code surfacing during the split (shared imports we
  didn't anticipate). Mitigation: the OPEN-allocation list + the enforcement guard force these into
  the open; resolve case-by-case in the plan.
- **Migration ordering** across packages. Mitigation: §9 — start with a single shared ordered
  migrations dir in `core`.
- **Env-var divergence.** The CC app needs the backbone secrets (SESSION_SECRET, ENC_KEY,
  DATABASE_URL, CRON_SECRET) replicated to its new Vercel project. Mitigation: enumerate and copy
  during step 3; CRON_SECRET verification is already a known follow-up.

## 13. Acceptance Criteria (Phase 1 done when…)

1. Repo is `packages/{core,ui,shared}` + `apps/{email,command-centre}`; old `server`/`web`
   single-app structure is gone.
2. `core` imports nothing from `apps/*`; `email` and `command-centre` import no code from each
   other; CI guard proves it.
3. `aiployee-emailer.vercel.app` still serves the email app, healthz 200, behaviour unchanged.
4. The command-centre app deploys to its own URL against the same Neon DB, with its crons.
5. Full test suite green.
6. The four OPEN allocations have explicit, recorded resolutions.
7. A tenant logged into the emailer can open the dashboard already authenticated (and vice
   versa) via token-handoff SSO; forged/expired/replayed tokens are rejected.

## 14. Open Questions Carried Into Planning

- Resolution of the four OPEN module allocations (§6).
- Migrations: single shared dir (§9a) vs per-package dirs with combined ordering (§9b) — confirm.
- Does the email app need *any* of Abe's infra (RAG/MCP) for its reply agent, or is the reply
  agent fully independent?
- Exact env-var set to replicate to the new CC Vercel project.
```
