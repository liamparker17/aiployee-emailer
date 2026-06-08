# Segmentation Phase 1 — "The Seam" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the overgrown emailer repo into `packages/core` + `packages/ui` + `packages/shared` + `apps/email` + `apps/command-centre`, with hard import boundaries, while the email app keeps deploying unchanged to `aiployee-emailer.vercel.app`.

**Architecture:** One npm-workspace monorepo (it already is one). Backbone code (auth, tenants, contacts, suppressions, db, crypto, util) moves to `@aiployee/core`; shared React moves to `@aiployee/ui`; the single Fastify `buildApp` is split into two app-specific `buildApp`s (email vs command-centre), each importing `core`. Two Vercel projects deploy from one repo via different Root Directories.

**Tech Stack:** Node 24, TypeScript, Fastify 5, Vite + React 18, npm workspaces, node-pg-migrate, Vitest, Neon Postgres, Vercel.

---

## Conventions for this plan (read first)

This is a **restructure**, not greenfield. Two conventions make the steps concrete without pasting the body of every moved file:

1. **Move-lists, not file bodies.** When a step says "move X → Y", the file content is unchanged; only its path and import specifiers change. The exact source→dest paths ARE the concrete content.
2. **Compiler-as-oracle for imports.** After any move, the verification is `npm run build` (tsc). Every unresolved-import error is fixed by repointing that import to its new home (`@aiployee/core`, `@aiployee/ui`, `@aiployee/shared`, or a sibling within the same app). Repeat build→fix until green. This is a deterministic procedure, not a placeholder.
   - ⚠️ **`tsc` does NOT cover `server/test/**`** (vitest transforms those, not the build). After moving a module, you MUST also rewrite test-file imports of it (tests reference source as `../src/<module>.js`). Run the same sed over `server/test`. A clean `npm run build` with broken test imports is a false green.
   - ⚠️ **Never read a test result through `| tail`** — the pipe makes the shell report `tail`'s exit code (always 0), masking a failed suite. Run the suite unpiped (or `echo ${PIPESTATUS[0]}`) and confirm `VITEST EXIT: 0` plus the `Test Files … passed` summary.

**Definition of "green" used throughout:** `npm run build` exits 0 **and** the server tests pass. Tests are DB-backed integration tests that read **`TEST_DATABASE_URL`** (NOT `DATABASE_URL`) and **must** run serially. The canonical command is:

```bash
TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism
```

There is **no local Postgres** on this machine — Neon's `test` branch is the only DB. If `TEST_DATABASE_URL` is unset the harness falls back to `localhost:5433` and every test fails with `ECONNREFUSED`. Never run two suites concurrently on the shared `test` branch. After the app split, the workspace flag changes (e.g. `-w @aiployee/email-server`) but the env var and `--no-file-parallelism` stay.

**Authoritative module allocation:** see the spec §6, `docs/superpowers/specs/2026-06-08-aiployee-segmentation-design.md`. The current route set is the `register*Routes` list in `server/src/app.ts` (lines ~8–102).

---

## Task 0: Baseline & branch

**Files:** none moved; this establishes a safe starting point.

- [ ] **Step 1: Create the working branch** (master is the default branch — do not work on it directly)

```bash
git checkout -b feat/segmentation
```

- [ ] **Step 2: Capture the green baseline**

```bash
npm install
npm run build
TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism
```

Expected: build exits 0; Vitest all-pass. Record the pass count — every later task must match or exceed it.

- [ ] **Step 3: Record the deployed asset hash** (so we can prove the email app is byte-stable later)

```bash
curl -s https://aiployee-emailer.vercel.app/healthz   # expect {"ok":true}
```

Note the current `server/public/assets/index-*.js` filename from a local `npm run build`.

- [ ] **Step 4: Commit the plan + spec onto the branch** (if not already present)

```bash
git add docs/superpowers && git commit -m "docs: segmentation phase 1 plan + spec" || echo "already committed"
```

---

## Task 1: Scaffold the new packages (empty, wired, still green)

Create the package skeletons and wire them into the workspace **before moving any code**, so the build stays green at every later step.

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts` (empty barrel)
- Create: `packages/ui/package.json`
- Create: `packages/ui/tsconfig.json`
- Create: `packages/ui/src/index.ts` (empty barrel)
- Modify: root `package.json` (workspaces array)

- [ ] **Step 1: Move existing `shared/` under `packages/`** to unify package location

```bash
git mv shared packages/shared
```

- [ ] **Step 2: Write `packages/core/package.json`**

```json
{
  "name": "@aiployee/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } },
  "scripts": { "build": "tsc -p tsconfig.json" },
  "dependencies": {
    "@aiployee/shared": "*",
    "@fastify/cookie": "^11.0.2",
    "@fastify/cors": "^10.0.1",
    "@fastify/session": "^11.0.2",
    "bcryptjs": "^2.4.3",
    "connect-pg-simple": "^9.0.1",
    "fastify": "^5.0.0",
    "pg": "^8.13.0",
    "pino": "^9.4.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/bcryptjs": "^2.4.6",
    "@types/pg": "^8.11.10",
    "typescript": "^5.6.2"
  }
}
```

- [ ] **Step 3: Write `packages/core/tsconfig.json`** (mirror `server/tsconfig.json`'s compiler options; output to `dist`)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "declaration": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

> NOTE: If `server/tsconfig.json` differs (verify by opening it), copy its `compilerOptions` verbatim so behaviour is identical.

- [ ] **Step 4: Write `packages/core/src/index.ts`**

```ts
export {}; // populated as modules move in Task 2
```

- [ ] **Step 5: Write `packages/ui/package.json`**

```json
{
  "name": "@aiployee/ui",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "@aiployee/shared": "*",
    "lucide-react": "^0.460.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.2"
  },
  "devDependencies": {
    "@types/react": "^18.3.10",
    "@types/react-dom": "^18.3.0",
    "typescript": "^5.6.2"
  }
}
```

> NOTE: `@aiployee/ui` is consumed by Vite (source-level), so it ships `.tsx` source via `main: src/index.ts` rather than a build step — matching how `web` already consumes `@aiployee/shared`.

- [ ] **Step 6: Write `packages/ui/tsconfig.json`** (mirror `web/tsconfig.json`) and `packages/ui/src/index.ts`

```ts
export {}; // populated in Task 4
```

- [ ] **Step 7: Update root `package.json` workspaces**

```json
"workspaces": ["packages/*", "server", "web"]
```

- [ ] **Step 8: Reinstall, build, test**

```bash
npm install
npm run build
TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism
```

Expected: green. Nothing functional changed; this only added empty packages and relocated `shared`.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "chore(segmentation): scaffold @aiployee/core + @aiployee/ui, move shared under packages/"
```

---

## Task 2: Move the backbone into `@aiployee/core`

Move backbone server modules in **low-coupling-first slices**, rebuilding after each slice so a broken import surfaces immediately. After each slice, add the moved symbols to `packages/core/src/index.ts`.

**Allocation (from spec §6):**
- `db/pool.ts`
- `crypto/enc.ts`
- `util/logger.ts`, `util/errors.ts`
- `auth/session.ts`, `auth/password.ts`, `auth/apiKey.ts`, `auth/csrf.ts`, `auth/ctx.ts`
- repos: `tenants.ts`, `users.ts`, `apiKeys.ts`, `contacts.ts`, `contactLists.ts`, `segments.ts`, `suppressions.ts`
- platform routes: `auth.ts`, `session.ts`, `users.ts`, `adminTenants.ts`, `apiKeys.ts`

**Slice order (rebuild after each):**

- [ ] **Step 1: Slice A — leaf utilities** (`util/*`, `crypto/enc.ts`, `db/pool.ts`)

```bash
git mv server/src/util packages/core/src/util
git mv server/src/crypto packages/core/src/crypto
mkdir -p packages/core/src/db && git mv server/src/db/pool.ts packages/core/src/db/pool.ts
```

Add to `packages/core/src/index.ts`:

```ts
export * from './util/logger.js';
export * from './util/errors.js';
export * from './crypto/enc.js';
export * from './db/pool.js';
```

Then run the **compiler-as-oracle** loop:

```bash
npm run build   # fix every "Cannot find module './util/...'" in server/* by importing from '@aiployee/core'
```

Repeat build→fix until green, then run the test command (see "green" definition above).

- [ ] **Step 2: Commit Slice A**

```bash
git add -A && git commit -m "refactor(core): move util/crypto/db pool into @aiployee/core"
```

- [ ] **Step 3: Slice B — auth** (`auth/*`)

```bash
git mv server/src/auth packages/core/src/auth
```

Add `export * from './auth/session.js';` etc. for each auth module to the core barrel. Run the compiler-as-oracle loop (server route files import `registerSessions`, `registerCsrf`, `registerCtx`, password/apiKey/ctx helpers from `@aiployee/core`). Build + test green. Commit:

```bash
git add -A && git commit -m "refactor(core): move auth (session/csrf/ctx/password/apiKey) into @aiployee/core"
```

- [ ] **Step 4: Slice C — backbone repos** (`tenants`, `users`, `apiKeys`, `contacts`, `contactLists`, `segments`, `suppressions`)

```bash
mkdir -p packages/core/src/repos
git mv server/src/repos/tenants.ts      packages/core/src/repos/tenants.ts
git mv server/src/repos/users.ts        packages/core/src/repos/users.ts
git mv server/src/repos/apiKeys.ts      packages/core/src/repos/apiKeys.ts
git mv server/src/repos/contacts.ts     packages/core/src/repos/contacts.ts
git mv server/src/repos/contactLists.ts packages/core/src/repos/contactLists.ts
git mv server/src/repos/segments.ts     packages/core/src/repos/segments.ts
git mv server/src/repos/suppressions.ts packages/core/src/repos/suppressions.ts
```

Add each to the core barrel. Compiler-as-oracle loop. Build + test green. Commit:

```bash
git add -A && git commit -m "refactor(core): move backbone repos (tenants/users/apikeys/contacts/lists/segments/suppressions)"
```

> ⚠️ **OPEN-allocation gate (spec §6):** before moving `segments.ts`, grep it for imports of email-events/campaign code. If `segments` depends on email-only modules, that coupling must be broken (extract the shared bit) or `segments` stays app-side. Record the decision in a commit message. Do the same check for `contacts` ↔ email.

- [ ] **Step 5: Slice D — platform routes** (`auth`, `session`, `users`, `adminTenants`, `apiKeys`)

```bash
git mv server/src/routes/auth.js        packages/core/src/routes/auth.ts 2>/dev/null || \
  git mv server/src/routes/auth.ts      packages/core/src/routes/auth.ts
git mv server/src/routes/session.ts     packages/core/src/routes/session.ts
git mv server/src/routes/users.ts       packages/core/src/routes/users.ts
git mv server/src/routes/adminTenants.ts packages/core/src/routes/adminTenants.ts
git mv server/src/routes/apiKeys.ts     packages/core/src/routes/apiKeys.ts
```

Export the `register*Routes` from the core barrel. In `server/src/app.ts`, change these five imports to come from `@aiployee/core`. Compiler-as-oracle loop. Build + test green. Commit:

```bash
git add -A && git commit -m "refactor(core): move platform routes (auth/session/users/adminTenants/apiKeys)"
```

---

## Task 3: Resolve the four OPEN allocations (spec §6/§14)

Decide each explicitly and move accordingly. Each is its own commit with the rationale.

- [ ] **Step 1: `emailEvents`** — Decision rule: if any command-centre code (Abe, calls, dashboard) reads `emailEvents` for the unified inbox, it is the **core conversations spine** → move to `packages/core/src/repos/emailEvents.ts`. If only email reads it → leave in `apps/email` (Task 5). Grep for importers first:

```bash
grep -rl "emailEvents" server/src apps 2>/dev/null
```

Move (or not) per the rule; build+test; commit with rationale.

- [ ] **Step 2: `eventWebhooks` + `eventDelivery`** — generic outbound customer webhooks. Default: **core** (platform feature usable by both apps). Move `repos/eventWebhooks.ts`, `routes/eventWebhooks.ts`, `webhooks/eventDelivery.ts` to core unless grep shows email-only usage. Build+test; commit.

- [ ] **Step 3: MCP + RAG infra** (`repos/mcpServers.ts`, `agent/mcp.ts`, `agent/ragSqlProvider.ts`, `agent/ragVectorProvider.ts`, `repos/ragDocuments.ts`, `repos/ragSqlSources.ts`) — Decision rule: if **only** Abe uses them → `apps/command-centre` (Task 6). If the **email reply agent** also uses them → `packages/core/src/agent-infra/`. Grep both agents' imports; move per rule; build+test; commit.

- [ ] **Step 4: `segments`** — already gated in Task 2 Step 4; confirm the recorded decision here and ensure no email coupling leaked into core.

---

## Task 4: Move shared React into `@aiployee/ui`

**Allocation:** design-system components used by *both* apps + cross-app plumbing.

**Files to move** (from `web/src/components/` and `web/src/`):
- `components/Button.tsx`, `Card.tsx`, `Input.tsx`, `Modal.tsx`, `Toast.tsx`, `Skeleton.tsx`, `EmptyState.tsx`, `PageHeader.tsx`, `Table.tsx`, `StatusBadge.tsx`, `CopyButton.tsx`, `Logo.tsx`
- `auth.tsx` (auth context/provider), `api.ts` (API client), `components/TenantSwitcher.tsx`, `lib/tenants.ts`

- [ ] **Step 1: Move components**

```bash
mkdir -p packages/ui/src/components
git mv web/src/components/Button.tsx packages/ui/src/components/Button.tsx
# …repeat for each shared component listed above…
git mv web/src/auth.tsx packages/ui/src/auth.tsx
git mv web/src/api.ts   packages/ui/src/api.ts
git mv web/src/lib/tenants.ts packages/ui/src/lib/tenants.ts
git mv web/src/components/TenantSwitcher.tsx packages/ui/src/components/TenantSwitcher.tsx
```

- [ ] **Step 2: Populate `packages/ui/src/index.ts`** with `export * from './components/Button.js'` … (one line per moved component) plus `export * from './auth.js'`, `export * from './api.js'`.

> NOTE: Vite resolves `@aiployee/ui` from source. Confirm `web/vite.config.ts` has no `optimizeDeps`/alias that needs `@aiployee/ui` added; if it aliases `@aiployee/shared`, add `@aiployee/ui` the same way.

- [ ] **Step 3: Add `@aiployee/ui` to `web/package.json` dependencies** (`"@aiployee/ui": "*"`).

- [ ] **Step 4: Compiler-as-oracle for the web build**

```bash
npm install
npm -w web run build   # fix every unresolved import to point at '@aiployee/ui'
```

Repeat until the Vite build succeeds.

- [ ] **Step 5: Full build + test + commit**

```bash
npm run build
TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism
git add -A && git commit -m "refactor(ui): move shared design-system + auth/api client into @aiployee/ui"
```

---

## Task 5: Carve `apps/email`

Create the email app as its own server+web, importing `@aiployee/core`/`@aiployee/ui`. This is where the single `buildApp` is split.

**Files:**
- Create: `apps/email/server/` (move email server modules here)
- Create: `apps/email/server/src/app.ts` (email-only `buildApp`)
- Create: `apps/email/server/package.json`, `tsconfig.json`
- Create: `apps/email/api/index.ts`
- Create: `apps/email/vercel.json` (email crons only)
- Create: `apps/email/web/` (move email pages here)

- [ ] **Step 1: Relocate the server shell**

```bash
git mv server apps/email/server
```

(After Task 2 the `server/` tree already excludes backbone code; what remains is email + command-centre, which we separate next.)

- [ ] **Step 2: Move command-centre server code OUT to a holding area** so `apps/email/server` is email-only. Create `apps/command-centre/server/src/` and move CC modules (full list in Task 6). For now, move the obvious CC route files, repos, and `agent/abe/*`, `agent/runner.ts`, `agent/webhook.ts` out of `apps/email/server/src`.

```bash
mkdir -p apps/command-centre/server/src/{routes,repos,agent}
git mv apps/email/server/src/agent/abe apps/command-centre/server/src/agent/abe
git mv apps/email/server/src/agent/runner.ts apps/command-centre/server/src/agent/runner.ts
git mv apps/email/server/src/agent/webhook.ts apps/command-centre/server/src/agent/webhook.ts
git mv apps/email/server/src/routes/abe.ts          apps/command-centre/server/src/routes/abe.ts
git mv apps/email/server/src/routes/agent.ts        apps/command-centre/server/src/routes/agent.ts
git mv apps/email/server/src/routes/agentChat.ts    apps/command-centre/server/src/routes/agentChat.ts
git mv apps/email/server/src/routes/lineReports.ts  apps/command-centre/server/src/routes/lineReports.ts
git mv apps/email/server/src/routes/callAnalytics.ts apps/command-centre/server/src/routes/callAnalytics.ts
git mv apps/email/server/src/routes/callAgents.ts   apps/command-centre/server/src/routes/callAgents.ts
git mv apps/email/server/src/routes/callCampaigns.ts apps/command-centre/server/src/routes/callCampaigns.ts
git mv apps/email/server/src/routes/callHandovers.ts apps/command-centre/server/src/routes/callHandovers.ts
git mv apps/email/server/src/routes/jobixTriggers.ts apps/command-centre/server/src/routes/jobixTriggers.ts
git mv apps/email/server/src/routes/flows.ts        apps/command-centre/server/src/routes/flows.ts
# CC repos:
git mv apps/email/server/src/repos/agent.ts          apps/command-centre/server/src/repos/agent.ts
git mv apps/email/server/src/repos/agentApprovals.ts apps/command-centre/server/src/repos/agentApprovals.ts
git mv apps/email/server/src/repos/agentChat.ts      apps/command-centre/server/src/repos/agentChat.ts
git mv apps/email/server/src/repos/agentDormant.ts   apps/command-centre/server/src/repos/agentDormant.ts
git mv apps/email/server/src/repos/agentEligible.ts  apps/command-centre/server/src/repos/agentEligible.ts
git mv apps/email/server/src/repos/agentGoals.ts     apps/command-centre/server/src/repos/agentGoals.ts
git mv apps/email/server/src/repos/agentOutcomes.ts  apps/command-centre/server/src/repos/agentOutcomes.ts
git mv apps/email/server/src/repos/agentPlays.ts     apps/command-centre/server/src/repos/agentPlays.ts
git mv apps/email/server/src/repos/lineCallTags.ts   apps/command-centre/server/src/repos/lineCallTags.ts
git mv apps/email/server/src/repos/lineReports.ts    apps/command-centre/server/src/repos/lineReports.ts
git mv apps/email/server/src/repos/callHandovers.ts  apps/command-centre/server/src/repos/callHandovers.ts
```

> Also move any of: `v1Jobix.ts`, `callFacts`/call-related repos surfaced by the build. Use the compiler to catch stragglers.

- [ ] **Step 3: Write `apps/email/server/src/app.ts`** — a trimmed `buildApp` registering ONLY email + shared-platform routes. Base it on the original `app.ts` registration block, keeping these and importing the platform ones from `@aiployee/core`:

```ts
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, config as cfg } from '@aiployee/core';
import {
  registerSessions, registerCsrf, registerCtx,
  registerAuthRoutes, registerAdminTenantRoutes, registerUserRoutes,
  registerSessionRoutes, registerApiKeyRoutes, registerSuppressionRoutes,
} from '@aiployee/core';
import { registerSmtpConfigRoutes } from './routes/smtpConfigs.js';
import { registerSenderRoutes } from './routes/senders.js';
import { registerTemplateRoutes } from './routes/templates.js';
import { registerV1EmailRoutes } from './routes/v1Emails.js';
import { registerCronRoutes } from './routes/cron.js';
import { registerV1WebhookRoutes } from './routes/v1Webhooks.js';
import { registerEmailRoutes } from './routes/emails.js';
import { registerDomainRoutes } from './routes/domains.js';
import { registerTrackRoutes } from './routes/track.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerMarketingRoutes } from './routes/marketing.js';
import { registerSegmentRoutes } from './routes/segments.js';   // if segments stayed app-side
import { registerCampaignRoutes } from './routes/campaigns.js';

export async function buildApp() {
  const app = Fastify({ logger: false });
  await registerSessions(app, cfg, pool);
  registerCsrf(app);
  registerCtx(app);
  await registerAuthRoutes(app);
  await registerAdminTenantRoutes(app);
  await registerUserRoutes(app);
  await registerSessionRoutes(app);
  await registerApiKeyRoutes(app);
  await registerSuppressionRoutes(app);
  await registerSmtpConfigRoutes(app);
  await registerSenderRoutes(app);
  await registerTemplateRoutes(app);
  await registerV1EmailRoutes(app);
  await registerCronRoutes(app);            // email crons only after Task 7 split
  await registerV1WebhookRoutes(app);
  await registerEmailRoutes(app);
  await registerDomainRoutes(app);
  await registerTrackRoutes(app);
  await registerAnalyticsRoutes(app);
  await registerMarketingRoutes(app);
  await registerSegmentRoutes(app);
  await registerCampaignRoutes(app);
  app.get('/healthz', async () => ({ ok: true }));

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.resolve(__dirname, '../public');
  await app.register(fastifyStatic, { root: publicDir, prefix: '/', decorateReply: false, wildcard: false });
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/auth/') || req.url.startsWith('/v1/') || req.url === '/healthz') {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.sendFile('index.html');
  });
  return app;
}
```

> Verify exported names against the originals (e.g. `config`/`cfg`, the notFound handler body) by diffing against the original `server/src/app.ts` — keep behaviour identical.

- [ ] **Step 4: Write `apps/email/server/package.json`** (email deps only — drop `@modelcontextprotocol/sdk`, `openai` if the email reply agent doesn't need them; keep `nodemailer`, `pg`, `fastify`, `@fastify/*`, `zod`; add `@aiployee/core`, `@aiployee/ui` via web). Mirror scripts from the old `server/package.json` (`dev`, `build`, `start`, `test`, `migrate`).

- [ ] **Step 5: Write `apps/email/api/index.ts`** (copy old `api/index.ts`, change the import to `../server/src/app.js`).

- [ ] **Step 6: Write `apps/email/vercel.json`** — copy the original, keep ONLY email crons:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "npm run build",
  "outputDirectory": "server/public",
  "installCommand": "npm install",
  "functions": { "api/index.ts": { "maxDuration": 300 } },
  "crons": [
    { "path": "/v1/cron/process-queue", "schedule": "* * * * *" },
    { "path": "/v1/cron/retry-failed",  "schedule": "*/10 * * * *" }
  ],
  "rewrites": [
    { "source": "/healthz",     "destination": "/api/index" },
    { "source": "/auth/:path*", "destination": "/api/index" },
    { "source": "/api/:path*",  "destination": "/api/index" },
    { "source": "/v1/:path*",   "destination": "/api/index" },
    { "source": "/(.*)",        "destination": "/index.html" }
  ]
}
```

> The Vercel **Root Directory** for the existing project will be set to `apps/email` (Task 7), so these paths are relative to that.

- [ ] **Step 7: Move email web pages** into `apps/email/web/`:

```bash
mkdir -p apps/email/web/src/pages
git mv web/src/pages/{Senders,SmtpConfigs,Suppressions,Domains,EmailLog,Contacts,Lists,Segments,Campaigns,LaunchCampaign,Templates,AiResponses,EventWebhooks}.tsx apps/email/web/src/pages/
git mv web/src/pages/onboarding apps/email/web/src/pages/onboarding
# plus the email app's shell: main.tsx, routes.tsx, AppShell.tsx (email-scoped copy)
```

> The email app needs its own `routes.tsx`/`AppShell.tsx`/`main.tsx` listing only email pages + the shared platform pages (Login, Onboarding, Users, ApiKeys, AdminTenants, TenantPicker, AcceptInvite, Dashboard). Copy the originals and delete the CC routes (Abe, Calls, CallCampaigns, Flows, JobixBuilder).

- [ ] **Step 8: Write `apps/email/web/package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, tailwind/postcss configs** — copy from the current `web/` verbatim, adjusting only the build `outDir` to `../server/public`.

- [ ] **Step 9: Build the email app standalone + test**

```bash
npm install
npm -w @aiployee/email-server run build || npm run build
TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism
```

Run the compiler-as-oracle loop until green.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "feat(segmentation): carve apps/email (email-only buildApp, api, vercel, web)"
```

---

## Task 6: Stand up `apps/command-centre`

The CC server modules were moved in Task 5 Step 2. Now give the CC app its own shell so it builds and deploys independently.

**Files:**
- Create: `apps/command-centre/server/src/app.ts` (CC-only `buildApp`)
- Create: `apps/command-centre/server/package.json`, `tsconfig.json`
- Create: `apps/command-centre/api/index.ts`
- Create: `apps/command-centre/vercel.json` (CC crons)
- Create: `apps/command-centre/web/` (Abe, Calls, CallCampaigns, Flows, JobixBuilder pages + CC shell)

- [ ] **Step 1: Write `apps/command-centre/server/src/app.ts`** — same skeleton as email's `app.ts` (Task 5 Step 3) but registering platform routes from `@aiployee/core` plus the CC routes: `registerAgentRoutes`, `registerAbeRoutes`, `registerAgentChatRoutes`, `registerLineReportRoutes`, `registerCallAnalyticsRoutes`, `registerCallAgentRoutes`, `registerJobixTriggerRoutes`, `registerCallCampaignRoutes`, `registerFlowRoutes`, `registerCallHandoverRoutes`, `registerV1JobixRoutes`, and a CC `registerCronRoutes`. Keep the same static/SPA tail.

- [ ] **Step 2: Write `apps/command-centre/server/package.json`** — include `@modelcontextprotocol/sdk`, `openai`, `pg`, `fastify`, `@fastify/*`, `zod`, `@aiployee/core`. Mirror scripts from email's.

- [ ] **Step 3: Write `apps/command-centre/api/index.ts`** (copy, import `../server/src/app.js`).

- [ ] **Step 4: Write `apps/command-centre/vercel.json`** — CC crons only:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "npm run build",
  "outputDirectory": "server/public",
  "installCommand": "npm install",
  "functions": { "api/index.ts": { "maxDuration": 300 } },
  "crons": [
    { "path": "/v1/cron/abe-shift",          "schedule": "0 8 * * *" },
    { "path": "/v1/cron/abe-touches",        "schedule": "30 8 * * *" },
    { "path": "/v1/cron/abe-outcomes",       "schedule": "0 9 * * *" },
    { "path": "/v1/cron/line-report",        "schedule": "0 7 * * *" },
    { "path": "/v1/cron/abe-handovers",      "schedule": "*/5 * * * *" },
    { "path": "/v1/cron/process-call-queue", "schedule": "* * * * *" },
    { "path": "/v1/cron/process-flows",      "schedule": "* * * * *" }
  ],
  "rewrites": [
    { "source": "/healthz",     "destination": "/api/index" },
    { "source": "/auth/:path*", "destination": "/api/index" },
    { "source": "/api/:path*",  "destination": "/api/index" },
    { "source": "/v1/:path*",   "destination": "/api/index" },
    { "source": "/(.*)",        "destination": "/index.html" }
  ]
}
```

- [ ] **Step 5: Move CC web pages + write the CC shell**

```bash
mkdir -p apps/command-centre/web/src/pages
git mv web/src/pages/{Abe,Calls,CallCampaigns,Flows,JobixBuilder,Dashboard}.tsx apps/command-centre/web/src/pages/
git mv web/src/components/abe apps/command-centre/web/src/components/abe
git mv web/src/lib/{abe,calls,callCampaigns,jobixTriggers,flows}.ts apps/command-centre/web/src/lib/
```

Write CC `main.tsx`/`routes.tsx`/`AppShell.tsx` listing CC pages + shared platform pages (Login, TenantPicker, AcceptInvite, Users, AdminTenants). Copy tailwind/vite/tsconfig/index.html from `web/` (outDir `../server/public`).

> `Dashboard.tsx` belongs to the CC (cross-channel). If the email app also needs a light dashboard (spec §7 standalone requirement), give email its own minimal dashboard page rather than sharing this one.

- [ ] **Step 6: Delete the now-empty original `web/` and `server/` shells** once both apps build.

```bash
git rm -r web server 2>/dev/null || true
```

- [ ] **Step 7: Build everything + test**

```bash
npm install
npm run build     # root build must build core, ui, both apps
TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism
```

- [ ] **Step 8: Update root `package.json` scripts** to build/deploy both apps:

```json
"scripts": {
  "build": "npm -w @aiployee/core run build && npm -w @aiployee/email-server run build && npm -w @aiployee/cc-server run build",
  "test": "npm -w @aiployee/email-server run test && npm -w @aiployee/cc-server run test"
}
```

> Adjust workspace names to match the `name` fields you set. Email and CC test runs are **sequential** (`&&`, never `&`) because they share the one Neon `test` branch. Bake `--no-file-parallelism` into each app by setting `fileParallelism: false` in that app's `vitest.config.ts` (so the serial requirement can't be forgotten), and provide `TEST_DATABASE_URL` at invocation:
>
> ```bash
> TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm test
> ```

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(segmentation): stand up apps/command-centre; remove old single-app shell"
```

---

## Task 7: Migrations consolidation (spec §9)

- [ ] **Step 1: Move the migrations dir into core** (single shared ordered ledger — spec §9a)

```bash
git mv apps/email/server/migrations packages/core/migrations
```

- [ ] **Step 2: Add a root `migrate` script** that runs node-pg-migrate against `packages/core/migrations`:

```json
"migrate": "node-pg-migrate -m packages/core/migrations -d DATABASE_URL up"
```

- [ ] **Step 3: Verify against the test branch**

```bash
DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm run migrate
```

Expected: "No migrations to run" (all 34 already applied) — proves the path/ordering is intact.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore(segmentation): consolidate migrations under packages/core"
```

---

## Task 8: Boundary-enforcement guard (spec §7)

- [ ] **Step 1: Add `dependency-cruiser`** as a root dev dependency.

```bash
npm install -D dependency-cruiser
```

- [ ] **Step 2: Write `.dependency-cruiser.cjs`** with forbidden rules:

```js
module.exports = {
  forbidden: [
    { name: 'no-email-to-cc', severity: 'error',
      from: { path: '^apps/email' }, to: { path: '^apps/command-centre' } },
    { name: 'no-cc-to-email', severity: 'error',
      from: { path: '^apps/command-centre' }, to: { path: '^apps/email' } },
    { name: 'no-core-to-apps', severity: 'error',
      from: { path: '^packages/core' }, to: { path: '^apps/' } },
  ],
  options: { tsConfig: { fileName: 'tsconfig.json' }, doNotFollow: { path: 'node_modules' } },
};
```

- [ ] **Step 3: Add a `lint:boundaries` script** and run it (expect 0 violations):

```json
"lint:boundaries": "depcruise apps packages --config .dependency-cruiser.cjs"
```

```bash
npm run lint:boundaries   # expect: no dependency violations found
```

- [ ] **Step 4: Prove it fails on a deliberate cross-import** (add a temp import from `apps/email` into `apps/command-centre`, run, see it error, revert).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore(segmentation): enforce email/cc/core import boundaries via dependency-cruiser"
```

---

## Task 9: Deploy split (production — do last, carefully)

> This is the only step touching production Vercel. The email project is **never recreated** — only its Root Directory changes — so rollback is trivial.

- [ ] **Step 1: Merge `feat/segmentation` → `master`** only after Tasks 0–8 are green locally. (Vercel auto-deploys master.)

- [ ] **Step 2: BEFORE the email auto-deploy lands cleanly**, set the existing Vercel project `aiployee-emailer` **Root Directory = `apps/email`** (Vercel dashboard → Project Settings → General → Root Directory). Redeploy.

- [ ] **Step 3: Verify the email app is unchanged**

```bash
curl -s https://aiployee-emailer.vercel.app/healthz   # expect {"ok":true}
```

Confirm login, a campaign list load, and that the served asset hash corresponds to the new `apps/email/web` build.

- [ ] **Step 4: Create the NEW Vercel project** `aiployee-command-centre`, same Regalis team, Root Directory `apps/command-centre`, linked to the same GitHub repo/branch. Replicate env vars from the email project: `DATABASE_URL`, `SESSION_SECRET`, `ENC_KEY`, `CRON_SECRET`, plus any `OPENAI_*`/MCP keys the agent needs. (CRON_SECRET is a known-unverified item — verify it here.)

- [ ] **Step 5: Verify the CC app**

```bash
curl -s https://aiployee-command-centre.vercel.app/healthz   # expect {"ok":true}
```

Confirm login works against the shared DB and the Abe/dashboard pages load.

- [ ] **Step 6: Final commit / tag**

```bash
git tag segmentation-phase1-complete && git push --tags
```

---

## Task 10: Cross-app token-handoff SSO (spec decision #11)

Lets a logged-in tenant move emailer↔dashboard without re-authenticating, on the current
`*.vercel.app` URLs. The handoff helper lives in `@aiployee/core/auth` so **both** apps share one
implementation; each app exposes the two routes. **This is new auth code — TDD applies, and run
the `security-review` skill before merging (Task 9).**

**Design:** a short-lived (60s) HMAC token over `userId.tenantId.exp.jti`, keyed by the shared
`SESSION_SECRET`. Issuing app redirects to the destination app's accept route with the token; the
destination verifies (signature + expiry + single-use `jti`), loads the user from the shared DB,
mints its own session, and 302-redirects home so the token never lingers in a landing URL.

**Files:**
- Create: `packages/core/src/auth/handoff.ts`
- Test: `packages/core/test/handoff.test.ts` (or `apps/*/server/test` if core has no test runner yet)
- Create: a `handoff_used_jti` table migration in `packages/core/migrations` (replay guard)
- Modify: each app's `app.ts` to register the two handoff routes
- Modify: each app's web shell to add the cross-app link

- [ ] **Step 1: Write the failing unit test** for the token helper

```ts
import { describe, it, expect } from 'vitest';
import { issueHandoffToken, verifyHandoffToken } from '../src/auth/handoff.js';

describe('handoff token', () => {
  const secret = 'test-secret-please-change';
  it('round-trips a valid token', () => {
    const tok = issueHandoffToken({ userId: 'u1', tenantId: 't1' }, secret, 60);
    const out = verifyHandoffToken(tok, secret);
    expect(out).toMatchObject({ userId: 'u1', tenantId: 't1' });
  });
  it('rejects a tampered token', () => {
    const tok = issueHandoffToken({ userId: 'u1', tenantId: 't1' }, secret, 60);
    expect(() => verifyHandoffToken(tok.slice(0, -2) + 'xx', secret)).toThrow();
  });
  it('rejects an expired token', () => {
    const tok = issueHandoffToken({ userId: 'u1', tenantId: 't1' }, secret, -1);
    expect(() => verifyHandoffToken(tok, secret)).toThrow(/expired/);
  });
  it('rejects a token signed with a different secret', () => {
    const tok = issueHandoffToken({ userId: 'u1', tenantId: 't1' }, secret, 60);
    expect(() => verifyHandoffToken(tok, 'other-secret')).toThrow();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (module not found)

```bash
TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- handoff --no-file-parallelism
```

- [ ] **Step 3: Implement `packages/core/src/auth/handoff.ts`**

```ts
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export interface HandoffClaims { userId: string; tenantId: string; }
interface Payload extends HandoffClaims { exp: number; jti: string; }

const b64url = (b: Buffer) => b.toString('base64url');

function sign(body: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(body).digest());
}

export function issueHandoffToken(claims: HandoffClaims, secret: string, ttlSeconds = 60): string {
  const payload: Payload = {
    ...claims,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    jti: randomUUID(),
  };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${sign(body, secret)}`;
}

export function verifyHandoffToken(token: string, secret: string): Payload {
  const [body, mac] = token.split('.');
  if (!body || !mac) throw new Error('malformed handoff token');
  const expected = sign(body, secret);
  const a = Buffer.from(mac); const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('bad signature');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as Payload;
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error('expired handoff token');
  return payload;
}
```

- [ ] **Step 4: Run the test — expect PASS**

```bash
TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- handoff --no-file-parallelism
```

- [ ] **Step 5: Add the replay-guard migration** `packages/core/migrations/..._handoff_used_jti.cjs`

```js
exports.up = (pgm) => {
  pgm.createTable('handoff_used_jti', {
    jti: { type: 'uuid', primaryKey: true },
    used_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql("CREATE INDEX handoff_used_jti_used_at_idx ON handoff_used_jti (used_at)");
};
exports.down = (pgm) => pgm.dropTable('handoff_used_jti');
```

Apply to the test branch: `DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm run migrate`.

- [ ] **Step 6: Register routes in each app's `app.ts`** — `GET /auth/handoff` (authenticated; issues token, validates `?to=` against an **allowlist** of the two known app origins, 302s to `<to>/auth/handoff/accept?token=`), and `GET /auth/handoff/accept` (verifies token, rejects+deletes-on-use via `handoff_used_jti` insert that fails on duplicate, loads user, establishes session, 302 home). Allowlist constant:

```ts
const APP_ORIGINS = [
  'https://aiployee-emailer.vercel.app',
  'https://aiployee-command-centre.vercel.app',
];
```

Write a route-level integration test (Fastify `app.inject`) asserting: unauthenticated `/auth/handoff` → 401; a forged/expired token at `/auth/handoff/accept` → 401 and no session; a valid token → 302 + session cookie; replaying the same token → 401.

- [ ] **Step 7: Add the cross-app link in each web shell** — emailer `AppShell` gets "Open Command Centre" → `/auth/handoff?to=https://aiployee-command-centre.vercel.app`; CC `AppShell` gets "Open Email" → `/auth/handoff?to=https://aiployee-emailer.vercel.app`.

- [ ] **Step 8: Build + full test green + commit**

```bash
npm run build
TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server test -- --no-file-parallelism
git add -A && git commit -m "feat(sso): cross-app token-handoff login between emailer and command-centre"
```

> **Verification (post-deploy, in Task 9):** log into the emailer, click "Open Command Centre" → land authenticated as the same tenant; reverse the direction; confirm a replayed/expired token is rejected.

---

## Self-Review (completed against spec)

- **Spec coverage:** §5 layout → Tasks 1,4,5,6. §6 allocation → Tasks 2,5,6 + OPEN items Task 3. §7 enforcement → Task 8. §8 deploy/URL → Task 9. §9 migrations → Task 7. decision #11 cross-app SSO → Task 10. §10 sequencing → task order. §11 testing → "green" gate every task. §13 acceptance → Tasks 8 (boundary), 9 (URL + CC deploy), 10 (SSO), all (tests).
- **Open items** from spec §14 are each given an explicit decision step (Task 3) rather than deferred.
- **Known unknowns the implementer must resolve via the compiler/grep** (honestly flagged, not placeholders): the exact internal-import fixups per move (compiler-as-oracle), the precise per-app dependency trimming, and whether `segments`/`emailEvents`/RAG land in core or app (Task 3 decision rules).
```
