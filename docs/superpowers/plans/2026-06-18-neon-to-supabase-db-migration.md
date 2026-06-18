# Neon → Supabase DB Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Aiployee Emailer production database from Neon Postgres to Supabase Postgres with zero data loss and a one-step rollback.

**Architecture:** Database-only migration. The app keeps `pg.Pool`, `node-pg-migrate`, `connect-pg-simple` sessions, bcrypt auth, and Vercel Blob. Data moves via `pg_dump --schema=public` → restore. The app runtime connects through Supabase's Supavisor **transaction pooler** (serverless-safe); future migrations use the **session pooler**. The Vitest suite stays on the Neon `test` branch.

**Tech Stack:** Node 24, `pg` 8, `node-pg-migrate` 7, Fastify 5 on Vercel serverless (`api/index.ts` and `apps/command-centre/api/cc.ts`), Supabase Postgres + pgvector.

## Global Constraints

- **Scope is database-only.** Do NOT change auth, session logic, RAG provider code, Vercel Blob, or the 42 migration files.
- **Tests stay on Neon.** The test `DATABASE_URL` (`C:\Users\liamp\.aiployee-test-db-url`, Neon `test` branch) is NOT modified by this work.
- **Both Vercel projects use `DATABASE_URL`:** `aiployee-emailer` AND `command-centre` (the latter bundles the same backend via `_app.mjs`). Any prod env change applies to both.
- **App runtime connection** = Supavisor transaction pooler, port **6543**, with `?sslmode=require`.
- **Migration connection** = Supavisor session pooler (or direct), port **5432**.
- **Neon prod stays untouched** until cutover is verified — it is the rollback target.
- Dump/restore and Supabase dashboard steps require credentials Claude does not have; those steps are run by Liam, with exact commands provided here.

---

### Task 1: Reduce pool size for the transaction pooler

**Files:**
- Modify: `packages/core/src/db/pool.ts:7`
- Test: `packages/core/test/pool.test.ts` (Create) — or `server/test/` if core has no test dir; see Step 1.

**Interfaces:**
- Consumes: `getPool(cfg: Config): pg.Pool` from `packages/core/src/db/pool.ts`.
- Produces: same signature; the returned pool's `.options.max` is `10`.

- [ ] **Step 1: Locate the core test directory**

Run: `ls packages/core/test 2>/dev/null || echo "NO_CORE_TEST_DIR"`

If `NO_CORE_TEST_DIR`, place the test at `server/test/pool.config.test.ts` instead and import via the built path `@aiployee/core` (matching how other `server/test` files import core). Otherwise create `packages/core/test/pool.test.ts`.

- [ ] **Step 2: Write the failing test**

Create the test file with:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { getPool, closePool } from '../src/db/pool.js'; // adjust path if placed in server/test (use '@aiployee/core')

afterAll(async () => { await closePool(); });

describe('db pool config', () => {
  it('caps connections at 10 for the transaction pooler', () => {
    const cfg = { databaseUrl: 'postgres://u:p@localhost:5432/db' } as any;
    const pool = getPool(cfg);
    expect((pool as any).options.max).toBe(10);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm -w server run test -- pool` (or the core workspace if the test lives there)
Expected: FAIL — `expected 25 to be 10`.

- [ ] **Step 4: Make the change**

In `packages/core/src/db/pool.ts`, change line 7:

```ts
  if (!pool) pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 10 });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm -w server run test -- pool`
Expected: PASS.

- [ ] **Step 6: Build core to confirm no type breakage**

Run: `npm -w @aiployee/core run build`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/db/pool.ts packages/core/test/pool.test.ts
git commit -m "fix(db): cap pool at 10 for Supabase transaction pooler"
```

---

### Task 2: Provision Supabase and collect connection strings (manual — Liam)

**Files:** none (dashboard + local notes).

**Interfaces:**
- Produces: three connection strings recorded locally for later tasks:
  - `SUPABASE_TXN_URL` — transaction pooler, port 6543 (becomes prod `DATABASE_URL`).
  - `SUPABASE_SESSION_URL` — session pooler, port 5432 (for migrations/restore).
  - These are pasted into commands in Tasks 3–4; do not commit them.

- [ ] **Step 1: Create the Supabase project**

In the Supabase dashboard, create a new project in the region nearest current prod (match Neon's region; for ABSA/Mafadi this is typically EU or closest available). Set a strong DB password and save it.

- [ ] **Step 2: Enable the `vector` extension**

In the Supabase dashboard SQL editor, run:

```sql
create extension if not exists vector;
```

Expected: success (pgcrypto/gen_random_uuid are already available — no action).

- [ ] **Step 3: Copy both connection strings**

From Project Settings → Database → Connection string:
- **Transaction pooler** (port 6543) → save as `SUPABASE_TXN_URL`, append `?sslmode=require` if not present.
- **Session pooler** (port 5432) → save as `SUPABASE_SESSION_URL`, append `?sslmode=require` if not present.

Record both in a local scratch file (NOT in git), e.g. `C:\Users\liamp\.aiployee-supabase-urls`.

- [ ] **Step 4: Verify raw connectivity (smoke)**

Run (PowerShell, substituting the session URL):

```
psql "<SUPABASE_SESSION_URL>" -c "select version(); select extname from pg_extension where extname in ('vector','pgcrypto');"
```

Expected: prints a Postgres version and lists both `vector` and `pgcrypto`.

---

### Task 3: Dry-run dump/restore + preview verification (Liam runs commands)

**Files:** none (data + a Vercel preview deploy).

**Interfaces:**
- Consumes: `SUPABASE_SESSION_URL` (Task 2); the Neon prod URL at `C:\Users\liamp\.aiployee-prod-db-url`.
- Produces: a verified Supabase DB containing all prod data and a green preview deploy pointed at it.

- [ ] **Step 1: Confirm client tool versions**

Run: `pg_dump --version` and `psql --version`
Expected: both ≥ 16. If lower than the Neon/Supabase server version, install the matching `postgresql-client` first. (Stop and report if below 16.)

- [ ] **Step 2: Dump the Neon `public` schema + data**

Run (PowerShell):

```
$neon = Get-Content C:\Users\liamp\.aiployee-prod-db-url -Raw
pg_dump "$($neon.Trim())" --schema=public --no-owner --no-privileges -Fc -f C:\Users\liamp\aiployee-neon-dryrun.dump
```

Expected: a `.dump` file is produced with no errors. (`-Fc` = custom format for `pg_restore`.)

- [ ] **Step 3: Restore into Supabase**

Run:

```
pg_restore --no-owner --no-privileges -d "<SUPABASE_SESSION_URL>" C:\Users\liamp\aiployee-neon-dryrun.dump
```

Expected: completes. Benign warnings about the `vector`/`pgcrypto` extension already existing or comments are acceptable; hard ERRORs on table/data creation are not — if any appear, stop and report.

- [ ] **Step 4: Verify row parity on key tables**

Run against Supabase:

```
psql "<SUPABASE_SESSION_URL>" -c "select 'tenants',count(*) from tenants union all select 'users',count(*) from users union all select 'emails',count(*) from emails union all select 'rag_documents',count(*) from rag_documents union all select 'pgmigrations',count(*) from pgmigrations;"
```

Compare each count to the same query run against the Neon prod URL. Expected: identical counts. `pgmigrations` should show the full set through `1700000000041`.

- [ ] **Step 5: Point a Vercel preview at Supabase**

Create a throwaway git branch, push it, and in the `aiployee-emailer` Vercel project set a **Preview**-scoped `DATABASE_URL` = `SUPABASE_TXN_URL` (transaction pooler). Trigger a preview deploy of that branch.

- [ ] **Step 6: Smoke-test the preview deploy**

Against the preview URL, verify in order:
1. `GET /healthz` → 200.
2. Log in with a known account → succeeds (exercises sessions + bcrypt over Supabase).
3. Send one test email → queued/sent without DB errors.
4. Trigger one RAG query path → returns results (exercises pgvector).
5. Open a call/analytics view → loads.

Expected: all pass with no connection-limit or SSL errors in Vercel runtime logs.

- [ ] **Step 7: Record the result**

Note pass/fail per check. If anything fails, diagnose before proceeding to cutover. Do NOT clean up the preview env var yet — it confirms the runtime path works.

---

### Task 4: Production cutover (Liam runs commands)

**Files:** Vercel prod env on BOTH projects; local `C:\Users\liamp\.aiployee-prod-db-url`.

**Interfaces:**
- Consumes: verified Supabase DB and connection strings.
- Produces: prod traffic served from Supabase; Neon retained as rollback.

- [ ] **Step 1: Open a maintenance window**

Announce a short window. In `aiployee-emailer` Vercel, temporarily disable crons OR set an env flag the cron routes already honor (if none exists, accept that crons may fire mid-cutover — they are idempotent queue pollers, but a final dump taken seconds later is safest). Note exact start time.

- [ ] **Step 2: Reset the Supabase DB to a clean state for the final load**

To avoid duplicate rows from the dry-run, drop and recreate `public` on Supabase:

```
psql "<SUPABASE_SESSION_URL>" -c "drop schema public cascade; create schema public; create extension if not exists vector;"
```

Expected: success.

- [ ] **Step 2b: Take the final Neon dump**

```
$neon = Get-Content C:\Users\liamp\.aiployee-prod-db-url -Raw
pg_dump "$($neon.Trim())" --schema=public --no-owner --no-privileges -Fc -f C:\Users\liamp\aiployee-neon-final.dump
```

- [ ] **Step 3: Restore the final dump into Supabase**

```
pg_restore --no-owner --no-privileges -d "<SUPABASE_SESSION_URL>" C:\Users\liamp\aiployee-neon-final.dump
```

Re-run the parity check from Task 3 Step 4. Expected: counts match Neon.

- [ ] **Step 4: Flip prod `DATABASE_URL` on BOTH projects**

In Vercel, set **Production** `DATABASE_URL` = `SUPABASE_TXN_URL` for:
1. `aiployee-emailer`
2. `command-centre`

Also update the local file:

```
Set-Content C:\Users\liamp\.aiployee-prod-db-url "<SUPABASE_TXN_URL>"
```

(Keep the old Neon string saved separately, e.g. `C:\Users\liamp\.aiployee-neon-rollback-url`, for rollback.)

- [ ] **Step 5: Redeploy both projects to production**

Redeploy `aiployee-emailer` and `command-centre` (promote latest or push to `master`). Wait for both builds to go green.

- [ ] **Step 6: Verify prod**

On both production URLs, repeat the Task 3 Step 6 checks (healthz, login, send, RAG, call view). Watch Vercel runtime logs for connection-limit/SSL errors during the next few cron firings (1–2 minutes).

Expected: all green; crons run without connection exhaustion.

- [ ] **Step 7: Re-enable crons and close the window**

Re-enable any crons disabled in Step 1. Note the end time.

---

### Task 5: Post-cutover hardening and cleanup

**Files:** Vercel preview env; `docs/superpowers/specs/2026-06-18-neon-to-supabase-db-migration-design.md` (status update); memory.

- [ ] **Step 1: Hold Neon as rollback for the agreed window**

Do NOT delete the Neon project. Keep it for at least 7 days. Rollback procedure if needed: set prod `DATABASE_URL` back to `C:\Users\liamp\.aiployee-neon-rollback-url` on both projects and redeploy.

- [ ] **Step 2: Remove the dry-run preview override**

In `aiployee-emailer` Vercel, delete the Preview-scoped `DATABASE_URL` from Task 3 Step 5 (so previews fall back to the standard env), unless you want previews to keep using Supabase intentionally.

- [ ] **Step 3: Confirm the Neon test branch is still green**

Run the full server suite against the Neon test branch (serially, per project convention):

Run: `npm -w server run test`
Expected: green — confirms tests were untouched and still use Neon.

- [ ] **Step 4: Update the spec status and commit**

In the design doc, change `Status: Approved (design)` to `Status: Shipped (YYYY-MM-DD)` and add a one-line cutover note.

```bash
git add docs/superpowers/specs/2026-06-18-neon-to-supabase-db-migration-design.md
git commit -m "docs(spec): mark Neon→Supabase migration shipped"
```

- [ ] **Step 5: Delete local dump files**

```
Remove-Item C:\Users\liamp\aiployee-neon-dryrun.dump, C:\Users\liamp\aiployee-neon-final.dump -ErrorAction SilentlyContinue
```

(These contain production data — do not leave them lying around.)

---

## Self-Review

**Spec coverage:**
- Connection/pooling split → Task 1 (pool max) + Tasks 2/3/4 (txn pooler for app, session pooler for migrations/restore). ✓
- Schema provisioning (`vector`) → Task 2 Step 2. ✓
- Data dump/restore mechanics (`--schema=public --no-owner --no-privileges`) → Tasks 3–4. ✓
- Cutover sequence with rollback → Task 4 + Task 5 Step 1. ✓
- Both Vercel projects updated → Task 4 Step 4 (resolved open item: command-centre bundles the same backend, so it needs the env). ✓
- SSL via `?sslmode=require` → Task 2 Step 3, Global Constraints. ✓
- Tests stay on Neon → Global Constraints + Task 5 Step 3. ✓
- "NOT touched" list → Global Constraints. ✓

**Placeholder scan:** No TBD/TODO. The one conditional (Task 1 Step 1 test location) has explicit both-branch instructions. ✓

**Type consistency:** `getPool`/`closePool` signatures match `pool.ts`; `.options.max` is the real `pg.Pool` property. Connection-string variable names (`SUPABASE_TXN_URL`, `SUPABASE_SESSION_URL`) are used consistently across Tasks 2–5. ✓

**Note:** SSL-fallback (`ssl: { rejectUnauthorized:false }`) from the spec is intentionally NOT a task — it is only applied if Task 2 Step 4 / Task 3 Step 6 surface a TLS error. If that happens, add it to `pool.ts` and re-test.
