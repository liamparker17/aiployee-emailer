# Segmentation — Production Cutover (authorized steps)

Branch `feat/segmentation` holds the full refactor. Everything below is verified locally
(`npm run build` green; targeted + SSO suites green; full suite gating). These are the
remaining **outward-facing** steps — they need your explicit go-ahead (and your Vercel login).

## What changed (so you know what's deploying)
- Monorepo now has `packages/{core,ui,shared}` + `web/` (email) + `apps/command-centre/web` (CC).
- Shared backbone (auth, tenants, contacts, suppressions, segments, **and the outbound-email
  transport**) lives in `@aiployee/core`. One shared backend (`server/`) serves both apps.
- New: cross-app **token-handoff SSO** (`/auth/handoff` + `/auth/handoff/accept`, migration 034
  `handoff_used_jti`).
- The email app's structure/Vercel project is **unchanged** (still deploys from repo root) —
  only its code now imports from the new packages.

## Step 1 — migrate production Neon (additive, safe)
Adds the `handoff_used_jti` table (nothing else schema-wise is new). Expand pattern: run BEFORE
deploying the code that uses it.
```
DATABASE_URL="$(cat /c/Users/liamp/.aiployee-prod-db-url)" npm -w server run migrate
```
Expect: applies `1700000000034_handoff_used_jti`, "Migrations complete!".

## Step 2 — deploy the email app (existing Vercel project)
Merge to master and push; Vercel auto-deploys the root project (`aiployee-emailer`).
```
git checkout master && git merge --no-ff feat/segmentation && git push origin master
```
Then verify (rollback in the Vercel dashboard if anything is off — recent deploys are rollback
candidates):
```
curl -s https://aiployee-emailer.vercel.app/healthz      # expect {"ok":true}
```
Confirm login + a campaign list load. The served asset should match the local `web` build
(`server/public/assets/index-*.js`).

## Step 3 — create the Command Centre Vercel project (needs your login)
New project, same Regalis team, **Root Directory = `apps/command-centre`**, linked to the same
GitHub repo/branch (master). Its `apps/command-centre/vercel.json` is already in place:
build = `cd ../.. && npm run build && npm -w @aiployee/cc-web run build`, outputDirectory `public`,
function `api/index.ts`, **no crons** (crons run only on the root project to avoid double-firing).

Replicate env vars from the email project onto the CC project:
`DATABASE_URL`, `SESSION_SECRET`, `EMAILER_ENC_KEY`, `CRON_SECRET`, plus any `OPENAI_*`/MCP keys
Abe needs. Then deploy and verify:
```
curl -s https://aiployee-command-centre.vercel.app/healthz   # expect {"ok":true}
```
Log in directly, and test the cross-app link: from the emailer sidebar click **Command Centre →**
(should land authenticated; and **Email →** back).

> I can drive Step 3 via the Vercel MCP once you complete its OAuth — say the word and I'll start
> the auth flow and create + configure the project.

## Deferred polish (non-blocking)
- Trim CC nav items (Abe/Calls/Flows) out of the **email** app's sidebar (they currently still
  show; harmless since the backend is shared, but not clean product separation).
- Optional `dependency-cruiser` guard for `core → apps` (lower value now that there's one backend).
- Phase 2: physically split the backend + its ~40 CC tests if/when true backend isolation is wanted.
