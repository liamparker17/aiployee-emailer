# Neon → Supabase DB Migration — Design

**Date:** 2026-06-18
**Status:** Approved (design)
**Scope owner:** Liam

## Goal

Move the Aiployee Emailer production database from Neon Postgres to Supabase
Postgres with **zero data loss** and a clean rollback path. This is a
**database-only** migration: no changes to auth, sessions logic, storage, RAG
code, or the application's data-access patterns beyond connection wiring.

## Locked Decisions

- **Scope:** Postgres database only. Keep `pg.Pool`, `node-pg-migrate`,
  `connect-pg-simple` sessions, bcrypt auth, and Vercel Blob exactly as they are.
- **Data:** full `pg_dump` → restore. Every tenant, email, call, and embedding
  is preserved. A short cutover/maintenance window is acceptable.
- **Tests:** the Vitest suite stays pointed at the **Neon `test` branch**. The
  test workflow and its `DATABASE_URL` are untouched by this migration.

## Current Architecture (verified 2026-06-18)

- **DB access:** single `pg.Pool({ connectionString: cfg.databaseUrl, max: 25 })`
  in `packages/core/src/db/pool.ts`. No ORM.
- **Config:** `DATABASE_URL` is the only DB env var (`packages/core/src/config.ts`).
- **Migrations:** `node-pg-migrate`, 42 numbered `.cjs` files in
  `server/migrations/` (`1700000000000`–`1700000000041`). Tracking table
  `pgmigrations` in `public`.
- **Sessions:** `connect-pg-simple` (Postgres-backed) + bcrypt auth — NOT
  Supabase Auth.
- **Storage:** Vercel Blob (campaign attachments).
- **RAG:** pgvector, 1536-dim embeddings (`server/migrations/...12_rag_documents.cjs`).
- **Hosting:** Vercel **serverless** — all routes route through a single
  `api/index.ts` function (`maxDuration: 300`), plus **11 cron jobs**, one firing
  every minute (`vercel.json`).
- **Schema portability:** uses only `pgcrypto`, `gen_random_uuid()`, and the
  `vector` extension. Nothing Neon-specific. Only a btree index on
  `rag_documents(tenant_id)` — no ivfflat/hnsw to rebuild.

## Design

### 1. Connection / Pooling (the key decision)

Because the app is serverless with frequent crons, use a **split** connection
strategy:

| Use | Connection | Port | Rationale |
|-----|-----------|------|-----------|
| **App runtime** (`DATABASE_URL`) | Supavisor **transaction pooler** | **6543** | Serverless fans out connections; transaction pooler multiplexes so the connection limit is never exhausted. `pg` parameterized queries and `connect-pg-simple` work in transaction mode. |
| **Migrations** (future `npm run migrate`) | Supavisor **session pooler** (or direct) | 5432 | `node-pg-migrate` uses advisory locks + DDL transactions, which require a session-scoped connection. Transaction pooler breaks these. |

**Alternative considered:** session pooler for everything with `max` lowered to
~5. Simpler (one URL) but riskier under the every-minute cron load. Rejected in
favor of the split.

**Code change:** in `packages/core/src/db/pool.ts`, lower `max: 25` → `max: 10`
(a large per-instance pool is pointless and risky behind the transaction pooler).
SSL is carried via `?sslmode=require` in the connection string — same as Neon
today, no `ssl` object needed. Fallback if TLS verification fails:
`ssl: { rejectUnauthorized: false }`.

### 2. Schema Provisioning on Supabase

- `pgcrypto` and `gen_random_uuid()` are native on Supabase — no action.
- **Enable `vector` before restore:** `create extension if not exists vector;`
- The `pgmigrations` tracking table is included in the dump, so the restored DB
  already records migration state at `41` — **migrations are not re-run**.

### 3. Data Migration Mechanics

- Dump from Neon with:
  `pg_dump --schema=public --no-owner --no-privileges` — dumping **only**
  `public` avoids clobbering Supabase's internal `auth`/`storage` schemas.
- Pre-create the `vector` extension on Supabase.
- Restore with `psql` / `pg_restore`.
- Use client tools (`pg_dump`/`pg_restore`) at a version **≥** the higher of the
  two server versions.

### 4. Cutover Sequence (with rollback)

1. **Provision** (manual, dashboard): create Supabase project in the region
   nearest current prod; enable `vector`. *Claude cannot do this step.*
2. **Dry run:** dump → restore into Supabase, point a Vercel **preview** deploy
   at it, smoke-test: login, send a test email, one RAG query, one call query.
3. **Cutover window:**
   1. Pause/disable crons.
   2. Final `pg_dump` from Neon.
   3. Restore into Supabase.
   4. Update `DATABASE_URL` in Vercel **prod** for `aiployee-emailer` (and
      `command-centre` *if* it reads the DB directly — TO VERIFY) and in local
      `C:\Users\liamp\.aiployee-prod-db-url`.
   5. Redeploy.
   6. Verify (health check, login, send, RAG, call query).
   7. Resume crons.
4. **Rollback:** leave Neon prod untouched during the window; rollback = revert
   `DATABASE_URL` to the Neon string and redeploy.

### 5. Explicitly NOT Touched

Test env / Neon `test` branch, auth, session logic, Vercel Blob, RAG provider
code, and the 42 migration files themselves.

## Open Items to Resolve During Implementation

1. **command-centre DB coupling:** confirm whether the `command-centre` app
   reads `DATABASE_URL` directly or only talks to the server API. Determines
   whether its Vercel env needs updating.
2. **SSL connectivity:** verify `pg` connects to the Supabase pooler with only
   `?sslmode=require` (no code-side `ssl` object). Apply the
   `rejectUnauthorized:false` fallback only if verification fails.

## Success Criteria

- Production app serves all routes against Supabase with no connection-limit
  errors under cron load.
- All migrated data present and queryable (tenants, emails, calls, embeddings).
- Login, email send, RAG query, and call query verified live post-cutover.
- Neon test branch still green for the Vitest suite.
- Documented rollback that reverts to Neon in one env change + redeploy.
