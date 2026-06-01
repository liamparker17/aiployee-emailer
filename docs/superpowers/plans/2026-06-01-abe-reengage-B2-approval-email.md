# Abe Re-engage — Plan B2: Approval Over Email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a tenant's configured line manager approve or reject a `pending_approval` play by clicking HMAC-signed, single-use, expiring links in an email Abe sends them — no login required.
**Architecture:** A pure token signer/verifier (mirroring the unsubscribe-link machinery) produces `${playId}.${expiresMs}.${sig}` tokens whose sha256 is stored in `agent_approvals.token_hash`. When a play enters `pending_approval` and the goal has a verified line manager, an escalation hook creates one `agent_approvals` row and sends an approval email via the tenant's default sender. Public, session-less routes under `/v1/agent/` verify the token (HMAC + expiry + single-use), record the decision, and on Approve call B1's `startPlayExecution`. A manager-verify flow gates approval behind a verified email.
**Tech Stack:** Fastify, Postgres (`pg` Pool), node-pg-migrate, Zod, Vitest (DB-backed, serial), Node `crypto`.
**Builds on:** Plan A + Plan B1. **Spec:** docs/superpowers/specs/2026-06-01-agentic-employee-reengage-design.md

---

## Scope / deferred

**In scope (this plan):**
- Migration adding an index on `agent_approvals.token_hash`.
- `approvalToken.ts`: `signApprovalToken`, `verifyApprovalToken` (rejects expired), `hashToken` (sha256 hex).
- `agentApprovals` repo: `createApproval`, `getActiveApprovalByPlay`, `consumeApproval`.
- `approvalEmail.ts`: `sendManagerVerifyEmail` and `sendApprovalEmail` (build HTML, send via default sender, create the approval row).
- Manager-verify: session `POST /api/agent/goals/verify-manager`; public `GET /v1/agent/verify-manager/:token` (sets `line_manager_verified_at`).
- Auth exclusion: add `/v1/agent/` to the `registerCtx` preHandler early-return.
- Escalation hook `escalatePlay(...)` — idempotent; the integration point into B1 Task 8's `pending_approval` branch.
- Public decision routes: `GET /v1/agent/approve/:token?d=approve|reject|view` (View renders a read-only summary page with Approve/Reject links).

**Deferred (NOT this plan):**
- Parsing/understanding free-text email replies. We set `Reply-To` to the default sender so a manager *can* reply in prose, but B2 does not read replies. (`agent_approvals.channel = 'reply'` exists but is never written here.)
- In-place copy editing from the View page (`decision = 'edit'` is never written here).

---

## Decisions (baked in)

- **Sender:** Both emails are sent via the tenant's default sender (B1 Task 3 `getDefaultSender(pool, tenantId)` → `{ email, ... }`). `from` and `reply_to` are both that sender's email.
- **No-block fallback:** If there is no default sender, no `line_manager_email`, or `line_manager_verified_at IS NULL`, escalation is a no-op — the play stays `pending_approval` and B1's in-app approve/reject remains the fallback. Never throw out of the escalation hook for these expected conditions.
- **Token:** `token = ${playId}.${expiresMs}.${sig(playId.expiresMs)}` where `sig` mirrors `server/src/marketing/unsubscribe.ts` exactly (`createHmac('sha256', key).update(payload).digest('base64url').slice(0,24)`). For verify-manager we reuse the same signer but encode `tenantId` instead of `playId` (`${tenantId}.${expiresMs}.${sig}`) — same code path, different payload string.
- **Expiry:** default 7 days (`7 * 24 * 60 * 60 * 1000` ms). `expiresMs` is an absolute epoch-ms deadline embedded in the token; `verifyApprovalToken` rejects when `Date.now() > expiresMs`. `agent_approvals.expires_at` stores the same deadline as a `timestamptz` for auditing/queries.
- **Single-use:** at issue, store `hashToken(token)` (sha256 hex) in `token_hash`. On use, the presented token must verify (HMAC + not expired), its `hashToken` must equal the stored `token_hash`, **and** `consumed_at IS NULL`. On success set `consumed_at = now()`, `decision`, `decided_at = now()`.
- **One row per play:** `getActiveApprovalByPlay` returns the most recent unconsumed row for a play; `escalatePlay` is a no-op if one already exists (idempotent — no double-send).
- **Decision via query param:** the signed token identifies the play; `?d=approve|reject|view` carries the action. Approve ⇒ `startPlayExecution` + consume; reject ⇒ play `rejected` + consume; view ⇒ render summary (no consume).

---

## Existing patterns to mirror (exact files)

- **Signer:** `server/src/marketing/unsubscribe.ts` — copy the `sig()` helper byte-for-byte.
- **Public page route:** `server/src/routes/campaigns.ts` `GET /v1/unsubscribe/:token` (lines ~113–128) — inline `const page = (msg) => '<!doctype html>...'`, verify token, no session, `reply.type('text/html').send(...)`.
- **Server-side send:** `server/src/routes/v1Emails.ts` (lines 22–41) — `queueEmail({ pool, enqueueSend: async()=>{}, input })` → `claimForSend(pool, email.id)` → `dispatchEmail({ pool, encKey, email, baseUrl })`.
- **Auth exclusion:** `server/src/auth/ctx.ts` line 18 (the `req.url.startsWith(...)` early-return chain).
- **Session route:** `server/src/routes/abe.ts` `registerAbeRoutes` (add the verify-manager session route and the public routes here).
- **DB email test (real test SMTP):** `server/test/v1Emails.test.ts` — `startTestSmtp(port)`, `createSmtpConfig(..., isDefault:true)`, `createSender`, assert `getEmail(...).status === 'sent'`.
- **Session admin test:** `server/test/abe.routes.test.ts` — `adminSession()` helper (`createTenant`, `createUser`, `csrfFor`, `login`).
- **Migration style:** `server/migrations/1700000000020_email_list_unsubscribe.cjs` (tiny up/down), and `server/migrations/1700000000021_abe.cjs` (`pgm.createIndex`).

**B1-provided interfaces this plan calls (must exist from Plan B1 before B2 starts):**
- `getDefaultSender(pool, tenantId): Promise<{ id; email; display_name; ... } | null>` in `server/src/repos/senders.ts` (B1 Task 3).
- `startPlayExecution({ pool, encKey, baseUrl, play }): Promise<{queued:number; skipped:number}>` in `server/src/agent/abe/execute.ts` (B1 Task 6). Acts only on status proposed/approved/pending_approval.
- B1 Task 8 adds a `pending_approval` branch to `server/src/agent/abe/shift.ts` (the tiered auto-fire decision). **Integration point:** that branch is where Task 7 below wires the `escalatePlay(...)` call.

---

## Tasks

### Task 1 — Migration: index on `agent_approvals.token_hash`

Single-use lookups hit `WHERE token_hash = $1`; add the index deferred from Plan A.

**Files:**
- create: `server/migrations/1700000000022_agent_approvals_token_hash_idx.cjs`

Steps:

- [ ] **Write the migration** (no separate test; the migrate run is the verification):

```js
/* eslint-disable camelcase */
// Single-use approval-token lookups query agent_approvals by token_hash; index it.
exports.up = (pgm) => {
  pgm.createIndex('agent_approvals', ['token_hash'], { name: 'agent_approvals_token_hash_idx' });
};
exports.down = (pgm) => {
  pgm.dropIndex('agent_approvals', ['token_hash'], { name: 'agent_approvals_token_hash_idx' });
};
```

- [ ] **Run the migration against the test branch** (expect "Migrating files" then success):

```bash
cd server && DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm run migrate
```

- [ ] **Verify the index exists** (expect one row naming `agent_approvals_token_hash_idx`):

```bash
cd server && psql "$(cat /c/Users/liamp/.aiployee-test-db-url)" -c "select indexname from pg_indexes where tablename='agent_approvals' and indexname='agent_approvals_token_hash_idx';"
```

- [ ] **Commit:**

```bash
git add server/migrations/1700000000022_agent_approvals_token_hash_idx.cjs && git commit -m "feat(abe-B2): index agent_approvals.token_hash for single-use lookups"
```

---

### Task 2 — Token signer/verifier/hasher (`approvalToken.ts`)

Pure functions, no DB. Mirrors `unsubscribe.ts`. Generic over the embedded id so verify-manager (tenantId) and approval (playId) share one code path.

**Files:**
- create: `server/src/agent/abe/approvalToken.ts`
- create: `server/test/abe.approvalToken.test.ts`

Steps:

- [ ] **Write the failing test:**

```ts
// server/test/abe.approvalToken.test.ts
import { describe, it, expect } from 'vitest';
import { signApprovalToken, verifyApprovalToken, hashToken } from '../src/agent/abe/approvalToken.js';

const KEY = Buffer.alloc(32, 7);

describe('approvalToken', () => {
  it('round-trips id + expiry', () => {
    const exp = Date.now() + 60_000;
    const tok = signApprovalToken('play-123', exp, KEY);
    const got = verifyApprovalToken(tok, KEY);
    expect(got).toEqual({ id: 'play-123', expiresMs: exp });
  });

  it('rejects a tampered signature', () => {
    const tok = signApprovalToken('play-123', Date.now() + 60_000, KEY);
    const tampered = tok.slice(0, -1) + (tok.endsWith('a') ? 'b' : 'a');
    expect(verifyApprovalToken(tampered, KEY)).toBeNull();
  });

  it('rejects a token signed with a different key', () => {
    const tok = signApprovalToken('play-123', Date.now() + 60_000, KEY);
    expect(verifyApprovalToken(tok, Buffer.alloc(32, 9))).toBeNull();
  });

  it('rejects an expired token', () => {
    const tok = signApprovalToken('play-123', Date.now() - 1, KEY);
    expect(verifyApprovalToken(tok, KEY)).toBeNull();
  });

  it('rejects a malformed token', () => {
    expect(verifyApprovalToken('nonsense', KEY)).toBeNull();
    expect(verifyApprovalToken('a.b', KEY)).toBeNull();
  });

  it('hashToken is deterministic 64-char hex and differs per token', () => {
    const tok = signApprovalToken('play-123', Date.now() + 60_000, KEY);
    const h = hashToken(tok);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(tok)).toBe(h);
    expect(hashToken(tok + 'x')).not.toBe(h);
  });
});
```

- [ ] **Run it & expect fail** (module does not exist yet):

```bash
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.approvalToken.test.ts --no-file-parallelism
```

- [ ] **Implement** (`server/src/agent/abe/approvalToken.ts`):

```ts
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

// HMAC over a payload string, identical construction to marketing/unsubscribe.ts `sig()`.
function sig(payload: string, key: Buffer): string {
  return createHmac('sha256', key).update(payload).digest('base64url').slice(0, 24);
}

/**
 * Signed, expiring token: `${id}.${expiresMs}.${sig(id.expiresMs)}`.
 * `id` is the playId (approval) or tenantId (verify-manager); `expiresMs` is an
 * absolute epoch-ms deadline. The verifier rejects expired tokens.
 */
export function signApprovalToken(id: string, expiresMs: number, key: Buffer): string {
  const payload = `${id}.${expiresMs}`;
  return `${payload}.${sig(payload, key)}`;
}

export function verifyApprovalToken(token: string, key: Buffer): { id: string; expiresMs: number } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [id, expiresStr, given] = parts;
  const expiresMs = Number(expiresStr);
  if (!Number.isFinite(expiresMs)) return null;
  const expected = sig(`${id}.${expiresStr}`, key);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Date.now() > expiresMs) return null;
  return { id, expiresMs };
}

// sha256 hex of the full token, stored in agent_approvals.token_hash for single-use checks.
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
```

- [ ] **Run & expect pass:**

```bash
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.approvalToken.test.ts --no-file-parallelism
```

- [ ] **Commit:**

```bash
git add server/src/agent/abe/approvalToken.ts server/test/abe.approvalToken.test.ts && git commit -m "feat(abe-B2): signed single-use expiring approval token"
```

---

### Task 3 — `agentApprovals` repo

CRUD for the approval row + single-use consume.

**Files:**
- create: `server/src/repos/agentApprovals.ts`
- create: `server/test/abe.approvals.repo.test.ts`

Steps:

- [ ] **Write the failing test** (uses the existing DB helpers; create tenant/goal/play directly via SQL to avoid LLM deps):

```ts
// server/test/abe.approvals.repo.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import {
  createApproval, getActiveApprovalByPlay, consumeApproval,
} from '../src/repos/agentApprovals.js';

const pool = makePool();
beforeAll(async () => {});
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function seedPlay(tenantId: string): Promise<string> {
  const g = await pool.query(
    `INSERT INTO agent_goals (tenant_id, kind, enabled) VALUES ($1, 'reengage_dormant', true) RETURNING id`,
    [tenantId],
  );
  const p = await pool.query(
    `INSERT INTO agent_plays (tenant_id, goal_id, status, risk_score, audience_snapshot, touches)
     VALUES ($1, $2, 'pending_approval', 50, '{"contact_ids":[],"size":0}', '[]') RETURNING id`,
    [tenantId, g.rows[0].id],
  );
  return p.rows[0].id;
}

describe('agentApprovals repo', () => {
  it('creates and reads back an active (unconsumed) approval', async () => {
    const t = await createTenant(pool);
    const playId = await seedPlay(t.id);
    const expiresAt = new Date(Date.now() + 86_400_000);
    const row = await createApproval({
      pool, playId, tenantId: t.id, tokenHash: 'h'.repeat(64),
      managerEmail: 'boss@x.io', expiresAt,
    });
    expect(row.play_id).toBe(playId);
    expect(row.consumed_at).toBeNull();
    expect(row.decision).toBeNull();

    const active = await getActiveApprovalByPlay(pool, playId);
    expect(active!.id).toBe(row.id);
  });

  it('consume sets decision/decided_at/consumed_at and is single-use', async () => {
    const t = await createTenant(pool);
    const playId = await seedPlay(t.id);
    const row = await createApproval({
      pool, playId, tenantId: t.id, tokenHash: 'h'.repeat(64),
      managerEmail: 'boss@x.io', expiresAt: new Date(Date.now() + 86_400_000),
    });

    const first = await consumeApproval(pool, row.id, 'approve');
    expect(first!.decision).toBe('approve');
    expect(first!.consumed_at).not.toBeNull();
    expect(first!.decided_at).not.toBeNull();

    // Second consume returns null (already consumed) — single-use enforced in SQL.
    const second = await consumeApproval(pool, row.id, 'reject');
    expect(second).toBeNull();

    // No longer "active".
    expect(await getActiveApprovalByPlay(pool, playId)).toBeNull();
  });

  it('getActiveApprovalByPlay returns null when none exist', async () => {
    const t = await createTenant(pool);
    const playId = await seedPlay(t.id);
    expect(await getActiveApprovalByPlay(pool, playId)).toBeNull();
  });
});
```

- [ ] **Run it & expect fail:**

```bash
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.approvals.repo.test.ts --no-file-parallelism
```

- [ ] **Implement** (`server/src/repos/agentApprovals.ts`):

```ts
import type pg from 'pg';

export type ApprovalDecision = 'approve' | 'reject' | 'edit';

export interface ApprovalRow {
  id: string;
  play_id: string;
  tenant_id: string;
  token_hash: string;
  manager_email: string;
  channel: 'button' | 'reply';
  decision: ApprovalDecision | null;
  decided_at: Date | null;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
}

export async function createApproval(args: {
  pool: pg.Pool;
  playId: string;
  tenantId: string;
  tokenHash: string;
  managerEmail: string;
  expiresAt: Date;
}): Promise<ApprovalRow> {
  const r = await args.pool.query<ApprovalRow>(
    `INSERT INTO agent_approvals (play_id, tenant_id, token_hash, manager_email, channel, expires_at)
     VALUES ($1, $2, $3, $4, 'button', $5)
     RETURNING *`,
    [args.playId, args.tenantId, args.tokenHash, args.managerEmail, args.expiresAt],
  );
  return r.rows[0];
}

// Most-recent unconsumed approval for a play (idempotency + decision-route lookups).
export async function getActiveApprovalByPlay(pool: pg.Pool, playId: string): Promise<ApprovalRow | null> {
  const r = await pool.query<ApprovalRow>(
    `SELECT * FROM agent_approvals
     WHERE play_id = $1 AND consumed_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [playId],
  );
  return r.rows[0] ?? null;
}

// Single-use: only consumes a row that is still unconsumed; returns null otherwise.
export async function consumeApproval(
  pool: pg.Pool,
  approvalId: string,
  decision: ApprovalDecision,
): Promise<ApprovalRow | null> {
  const r = await pool.query<ApprovalRow>(
    `UPDATE agent_approvals
        SET decision = $2, decided_at = now(), consumed_at = now()
      WHERE id = $1 AND consumed_at IS NULL
      RETURNING *`,
    [approvalId, decision],
  );
  return r.rows[0] ?? null;
}
```

- [ ] **Run & expect pass:**

```bash
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.approvals.repo.test.ts --no-file-parallelism
```

- [ ] **Commit:**

```bash
git add server/src/repos/agentApprovals.ts server/test/abe.approvals.repo.test.ts && git commit -m "feat(abe-B2): agentApprovals repo (create/getActive/consume, single-use)"
```

---

### Task 4 — Approval + verify emails (`approvalEmail.ts`)

Builds HTML, sends via the default sender using the queue→claim→dispatch path, and (for approvals) creates the `agent_approvals` row. No-block when prerequisites are missing.

**Files:**
- create: `server/src/agent/abe/approvalEmail.ts`
- create: `server/test/abe.approvalEmail.test.ts`

Steps:

- [ ] **Write the failing test** (real test SMTP, mirrors `v1Emails.test.ts`; asserts the email row is `sent` and the approval row was created with a matching `token_hash`):

```ts
// server/test/abe.approvalEmail.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createSmtpConfig } from '../src/repos/smtpConfigs.js';
import { createSender } from '../src/repos/senders.js';
import { startTestSmtp } from './helpers/smtp.js';
import { getEmail } from '../src/repos/emails.js';
import { getActiveApprovalByPlay } from '../src/repos/agentApprovals.js';
import { hashToken } from '../src/agent/abe/approvalToken.js';
import { sendApprovalEmail, sendManagerVerifyEmail } from '../src/agent/abe/approvalEmail.js';

const KEY = Buffer.alloc(32, 1);
const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: KEY.toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
  CRON_SECRET: 'c'.repeat(24),
});

let app: Awaited<ReturnType<typeof buildApp>>;
let smtp: ReturnType<typeof startTestSmtp>;
const pool = makePool();

beforeAll(async () => { smtp = startTestSmtp(2531); app = await buildApp({ cfg }); });
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await smtp.close(); await pool.end(); });

async function seed() {
  const t = await createTenant(pool);
  const sc = await createSmtpConfig(pool, KEY, {
    tenantId: t.id, name: 'local', host: '127.0.0.1', port: 2531, secure: false,
    username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
  });
  await createSender(pool, { tenantId: t.id, email: 'abe@x.com', displayName: 'Abe', smtpConfigId: sc.id });
  const g = await pool.query(
    `INSERT INTO agent_goals (tenant_id, kind, enabled, line_manager_email, line_manager_verified_at)
     VALUES ($1, 'reengage_dormant', true, 'boss@x.io', now()) RETURNING id`,
    [t.id],
  );
  const p = await pool.query(
    `INSERT INTO agent_plays (tenant_id, goal_id, status, risk_score, audience_snapshot, touches)
     VALUES ($1, $2, 'pending_approval', 60, '{"contact_ids":["c1","c2"],"size":2}',
             '[{"index":0,"subject":"Hey","body_html":"<p>hi</p>","scheduled_offset_days":0}]') RETURNING *`,
    [t.id, g.rows[0].id],
  );
  return { tenantId: t.id, play: p.rows[0] };
}

describe('sendApprovalEmail', () => {
  it('sends to the manager and creates a single-use approval row', async () => {
    const { tenantId, play } = await seed();
    const recv = smtp.lastMail();
    const res = await sendApprovalEmail({
      pool, encKey: cfg.encKey, baseUrl: cfg.publicBaseUrl,
      tenantId, play, managerEmail: 'boss@x.io',
    });
    expect(res.sent).toBe(true);

    const mail = await recv as { headers: Record<string, string> };
    expect(mail.headers.to).toContain('boss@x.io');

    const email = await getEmail(pool, tenantId, res.emailId!);
    expect(email!.status).toBe('sent');

    const approval = await getActiveApprovalByPlay(pool, play.id);
    expect(approval).not.toBeNull();
    expect(approval!.manager_email).toBe('boss@x.io');
    // token_hash equals hashToken(<token in the email>): token decodes the playId.
    expect(approval!.token_hash).toBe(hashToken(res.token!));
    expect(res.token!.startsWith(`${play.id}.`)).toBe(true);
  });

  it('is a no-op when the tenant has no default sender', async () => {
    const t = await createTenant(pool);
    const g = await pool.query(
      `INSERT INTO agent_goals (tenant_id, kind, enabled) VALUES ($1, 'reengage_dormant', true) RETURNING id`,
      [t.id],
    );
    const p = await pool.query(
      `INSERT INTO agent_plays (tenant_id, goal_id, status, risk_score, audience_snapshot, touches)
       VALUES ($1, $2, 'pending_approval', 10, '{"contact_ids":[],"size":0}', '[]') RETURNING *`,
      [t.id, g.rows[0].id],
    );
    const res = await sendApprovalEmail({
      pool, encKey: cfg.encKey, baseUrl: cfg.publicBaseUrl,
      tenantId: t.id, play: p.rows[0], managerEmail: 'boss@x.io',
    });
    expect(res.sent).toBe(false);
    expect(res.reason).toBe('no_default_sender');
    expect(await getActiveApprovalByPlay(pool, p.rows[0].id)).toBeNull();
  });
});

describe('sendManagerVerifyEmail', () => {
  it('sends a verify email to the manager', async () => {
    const { tenantId } = await seed();
    const recv = smtp.lastMail();
    const res = await sendManagerVerifyEmail({
      pool, encKey: cfg.encKey, baseUrl: cfg.publicBaseUrl,
      tenantId, managerEmail: 'boss@x.io',
    });
    expect(res.sent).toBe(true);
    const mail = await recv as { headers: Record<string, string> };
    expect(mail.headers.to).toContain('boss@x.io');
    const email = await getEmail(pool, tenantId, res.emailId!);
    expect(email!.status).toBe('sent');
  });
});
```

- [ ] **Run it & expect fail:**

```bash
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.approvalEmail.test.ts --no-file-parallelism
```

- [ ] **Implement** (`server/src/agent/abe/approvalEmail.ts`). `escapeHtml` prevents subject/body injection into the summary; the send helper mirrors `v1Emails.ts` exactly:

```ts
import type pg from 'pg';
import { getDefaultSender } from '../../repos/senders.js';
import { queueEmail } from '../../send/pipeline.js';
import { claimForSend, type EmailRow } from '../../repos/emails.js';
import { dispatchEmail } from '../../send/dispatch.js';
import type { PlayRow } from '../../repos/agentPlays.js';
import { signApprovalToken, hashToken } from './approvalToken.js';
import { createApproval } from '../../repos/agentApprovals.js';

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Queue → claim → dispatch a single email via the tenant's default sender.
// Mirrors server/src/routes/v1Emails.ts. Returns the sent email id, or a reason if it could not send.
async function sendViaDefault(args: {
  pool: pg.Pool; encKey: Buffer; baseUrl: string;
  tenantId: string; to: string; subject: string; html: string;
}): Promise<{ sent: true; emailId: string } | { sent: false; reason: 'no_default_sender' }> {
  const sender = await getDefaultSender(args.pool, args.tenantId);
  if (!sender) return { sent: false, reason: 'no_default_sender' };

  const email: EmailRow = await queueEmail({
    pool: args.pool,
    enqueueSend: async () => {},
    input: {
      tenantId: args.tenantId,
      from: sender.email,
      reply_to: sender.email,
      to: args.to,
      subject: args.subject,
      html: args.html,
    },
  });
  const claimed = await claimForSend(args.pool, email.id);
  if (claimed) {
    await dispatchEmail({ pool: args.pool, encKey: args.encKey, email: claimed, baseUrl: args.baseUrl });
  }
  return { sent: true, emailId: email.id };
}

export interface SendApprovalResult {
  sent: boolean;
  reason?: 'no_default_sender';
  emailId?: string;
  token?: string;
}

// Builds the approval email (play summary + Approve/Reject/View links), creates the
// approval row, and sends. The caller (escalatePlay) guarantees a verified manager.
export async function sendApprovalEmail(args: {
  pool: pg.Pool; encKey: Buffer; baseUrl: string;
  tenantId: string; play: PlayRow; managerEmail: string;
}): Promise<SendApprovalResult> {
  const expiresMs = Date.now() + TOKEN_TTL_MS;
  const token = signApprovalToken(args.play.id, expiresMs, args.encKey);
  const base = `${args.baseUrl}/v1/agent/approve/${encodeURIComponent(token)}`;
  const approveUrl = `${base}?d=approve`;
  const rejectUrl = `${base}?d=reject`;
  const viewUrl = `${base}?d=view`;

  const audienceSize = args.play.audience_snapshot.size;
  const touchRows = args.play.touches
    .map((t) => `<li>Touch ${t.index + 1} (day ${t.scheduled_offset_days}): <strong>${escapeHtml(t.subject)}</strong></li>`)
    .join('');

  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#1a0f3d;max-width:560px;margin:0 auto;padding:24px">
<h2>Approval needed: re-engage campaign</h2>
<p>Abe wants to send a re-engagement campaign to <strong>${audienceSize}</strong> dormant contact(s).</p>
<ul>${touchRows}</ul>
<p style="margin:28px 0">
  <a href="${approveUrl}" style="background:#2e7d32;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;margin-right:8px">Approve</a>
  <a href="${rejectUrl}" style="background:#c62828;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;margin-right:8px">Reject</a>
  <a href="${viewUrl}" style="color:#1a0f3d">View details</a>
</p>
<p style="font-size:12px;color:#666">This link is single-use and expires in 7 days. You can also reply to this email.</p>
</body></html>`;

  const result = await sendViaDefault({
    pool: args.pool, encKey: args.encKey, baseUrl: args.baseUrl,
    tenantId: args.tenantId, to: args.managerEmail,
    subject: `Approve re-engage campaign (${audienceSize} contacts)?`,
    html,
  });
  if (!result.sent) return { sent: false, reason: result.reason };

  await createApproval({
    pool: args.pool,
    playId: args.play.id,
    tenantId: args.tenantId,
    tokenHash: hashToken(token),
    managerEmail: args.managerEmail,
    expiresAt: new Date(expiresMs),
  });

  return { sent: true, emailId: result.emailId, token };
}

export interface SendVerifyResult {
  sent: boolean;
  reason?: 'no_default_sender';
  emailId?: string;
  token?: string;
}

// Builds + sends the manager-verification email. The token encodes the tenantId
// (not a playId); the public verify route sets line_manager_verified_at.
export async function sendManagerVerifyEmail(args: {
  pool: pg.Pool; encKey: Buffer; baseUrl: string;
  tenantId: string; managerEmail: string;
}): Promise<SendVerifyResult> {
  const expiresMs = Date.now() + TOKEN_TTL_MS;
  const token = signApprovalToken(args.tenantId, expiresMs, args.encKey);
  const verifyUrl = `${args.baseUrl}/v1/agent/verify-manager/${encodeURIComponent(token)}`;

  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#1a0f3d;max-width:560px;margin:0 auto;padding:24px">
<h2>Confirm you'll approve campaigns</h2>
<p>You've been set as the approver for Abe's re-engagement campaigns. Confirm this email address so you can approve or reject campaigns.</p>
<p style="margin:28px 0">
  <a href="${verifyUrl}" style="background:#2e7d32;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Confirm this email</a>
</p>
<p style="font-size:12px;color:#666">This link expires in 7 days.</p>
</body></html>`;

  const result = await sendViaDefault({
    pool: args.pool, encKey: args.encKey, baseUrl: args.baseUrl,
    tenantId: args.tenantId, to: args.managerEmail,
    subject: 'Confirm your email to approve Abe campaigns',
    html,
  });
  if (!result.sent) return { sent: false, reason: result.reason };
  return { sent: true, emailId: result.emailId, token };
}
```

- [ ] **Run & expect pass:**

```bash
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.approvalEmail.test.ts --no-file-parallelism
```

- [ ] **Commit:**

```bash
git add server/src/agent/abe/approvalEmail.ts server/test/abe.approvalEmail.test.ts && git commit -m "feat(abe-B2): build+send approval and manager-verify emails via default sender"
```

---

### Task 5 — Auth exclusion for `/v1/agent/`

Public agent routes must skip the API-key/session gate.

**Files:**
- modify: `server/src/auth/ctx.ts`
- create: `server/test/abe.publicAuth.test.ts`

Steps:

- [ ] **Write the failing test** (a `/v1/agent/...` path with a bad token must NOT 401 — it should reach the handler, which returns a 400 HTML page). The route itself lands in Task 7/8; this test asserts the *exclusion* by checking we do not get the auth 401 JSON. Until the route exists the handler 404s; after Task 7/8 it 400s. Assert "not 401" so the test is stable across both:

```ts
// server/test/abe.publicAuth.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool } from './helpers/db.js';

const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
  CRON_SECRET: 'c'.repeat(24),
});

let app: Awaited<ReturnType<typeof buildApp>>;
const pool = makePool();
beforeAll(async () => { app = await buildApp({ cfg }); });
afterAll(async () => { await app.close(); await pool.end(); });

describe('public /v1/agent/ auth exclusion', () => {
  it('does not require an API key (no 401) for a /v1/agent/ path', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/agent/verify-manager/bad.token' });
    expect(r.statusCode).not.toBe(401);
  });
});
```

- [ ] **Run it & expect fail** (currently `/v1/` without a key returns 401):

```bash
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.publicAuth.test.ts --no-file-parallelism
```

- [ ] **Implement** — add `/v1/agent/` to the early-return chain on line 18 of `server/src/auth/ctx.ts`. Replace:

```ts
    if (req.url === '/healthz' || req.url.startsWith('/v1/webhooks/') || req.url.startsWith('/v1/cron/') || req.url.startsWith('/v1/track/') || req.url.startsWith('/v1/unsubscribe/')) return;
```

with:

```ts
    if (req.url === '/healthz' || req.url.startsWith('/v1/webhooks/') || req.url.startsWith('/v1/cron/') || req.url.startsWith('/v1/track/') || req.url.startsWith('/v1/unsubscribe/') || req.url.startsWith('/v1/agent/')) return;
```

- [ ] **Run & expect pass:**

```bash
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.publicAuth.test.ts --no-file-parallelism
```

- [ ] **Commit:**

```bash
git add server/src/auth/ctx.ts server/test/abe.publicAuth.test.ts && git commit -m "feat(abe-B2): exclude public /v1/agent/ routes from auth gate"
```

---

### Task 6 — Manager-verify endpoints (session + public)

Session route emails the configured manager a verify link; public route sets `line_manager_verified_at`. Both go in `registerAbeRoutes`.

**Files:**
- modify: `server/src/routes/abe.ts`
- create: `server/test/abe.verifyManager.test.ts`

Steps:

- [ ] **Write the failing test** (session POST sends the email; capture the token from the sent HTML by re-signing it deterministically — instead, drive the public route with a token we sign ourselves, which is the contract). Two cases: public verify with a valid token sets the timestamp; session POST sends an email and 200s:

```ts
// server/test/abe.verifyManager.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant, createUser } from './helpers/factories.js';
import { csrfFor, login } from './helpers/auth.js';
import { createSmtpConfig } from '../src/repos/smtpConfigs.js';
import { createSender } from '../src/repos/senders.js';
import { startTestSmtp } from './helpers/smtp.js';
import { getGoal, upsertGoal } from '../src/repos/agentGoals.js';
import { signApprovalToken } from '../src/agent/abe/approvalToken.js';

const KEY = Buffer.alloc(32, 1);
const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: KEY.toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
  CRON_SECRET: 'c'.repeat(24),
});

let app: Awaited<ReturnType<typeof buildApp>>;
let smtp: ReturnType<typeof startTestSmtp>;
const pool = makePool();

beforeAll(async () => { smtp = startTestSmtp(2532); app = await buildApp({ cfg }); });
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await smtp.close(); await pool.end(); });

async function adminWithSender() {
  const t = await createTenant(pool);
  const sc = await createSmtpConfig(pool, KEY, {
    tenantId: t.id, name: 'local', host: '127.0.0.1', port: 2532, secure: false,
    username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
  });
  await createSender(pool, { tenantId: t.id, email: 'abe@x.com', displayName: 'Abe', smtpConfigId: sc.id });
  const password = 'pw-12345678';
  await createUser(pool, { tenantId: t.id, email: 'admin@x.io', password, role: 'tenant_admin' });
  const csrf = await csrfFor(app);
  const headers = await login(app, { email: 'admin@x.io', password }, csrf);
  return { tenantId: t.id, headers, csrf };
}

describe('manager verify', () => {
  it('session POST sends a verify email to the configured manager', async () => {
    const { tenantId, headers, csrf } = await adminWithSender();
    await upsertGoal(pool, tenantId, { enabled: true, lineManagerEmail: 'boss@x.io' });
    const recv = smtp.lastMail();
    const r = await app.inject({
      method: 'POST', url: '/api/agent/goals/verify-manager',
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().sent).toBe(true);
    const mail = await recv as { headers: Record<string, string> };
    expect(mail.headers.to).toContain('boss@x.io');
  });

  it('session POST 400s when no manager email is set', async () => {
    const { tenantId, headers, csrf } = await adminWithSender();
    await upsertGoal(pool, tenantId, { enabled: true });
    const r = await app.inject({
      method: 'POST', url: '/api/agent/goals/verify-manager',
      headers: { ...headers, 'x-csrf-token': csrf.csrfToken },
    });
    expect(r.statusCode).toBe(400);
  });

  it('public verify route sets line_manager_verified_at and is HTML', async () => {
    const t = await createTenant(pool);
    await upsertGoal(pool, t.id, { enabled: true, lineManagerEmail: 'boss@x.io' });
    const token = signApprovalToken(t.id, Date.now() + 60_000, KEY);
    const r = await app.inject({ method: 'GET', url: `/v1/agent/verify-manager/${encodeURIComponent(token)}` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    const goal = await getGoal(pool, t.id);
    expect(goal!.line_manager_verified_at).not.toBeNull();
  });

  it('public verify route rejects an expired/invalid token (400 HTML, no change)', async () => {
    const t = await createTenant(pool);
    await upsertGoal(pool, t.id, { enabled: true, lineManagerEmail: 'boss@x.io' });
    const expired = signApprovalToken(t.id, Date.now() - 1, KEY);
    const r = await app.inject({ method: 'GET', url: `/v1/agent/verify-manager/${encodeURIComponent(expired)}` });
    expect(r.statusCode).toBe(400);
    const goal = await getGoal(pool, t.id);
    expect(goal!.line_manager_verified_at).toBeNull();
  });
});
```

- [ ] **Run it & expect fail:**

```bash
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.verifyManager.test.ts --no-file-parallelism
```

- [ ] **Implement** — extend `server/src/routes/abe.ts`. Add these imports at the top (alongside the existing ones):

```ts
import { verifyApprovalToken } from '../agent/abe/approvalToken.js';
import { sendManagerVerifyEmail } from '../agent/abe/approvalEmail.js';
```

Add a small repo helper to set the verified timestamp by tenant — create it in `server/src/repos/agentGoals.ts` (append):

```ts
export async function markManagerVerified(pool: pg.Pool, tenantId: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE agent_goals SET line_manager_verified_at = now(), updated_at = now()
     WHERE tenant_id = $1 AND kind = 'reengage_dormant'`,
    [tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}
```

Import it in `abe.ts`:

```ts
import { getGoal, upsertGoal, markManagerVerified } from '../repos/agentGoals.js';
```

Then add, inside `registerAbeRoutes(app)` (after the existing `PUT /api/agent/goals` route), the session route:

```ts
  app.post('/api/agent/goals/verify-manager', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') {
        throw new AppError('forbidden', 403, 'Admin role required');
      }
      const goal = await getGoal(app.pool, ctx.tenantId);
      if (!goal?.line_manager_email) {
        throw new AppError('no_manager_email', 400, 'No line manager email is set on the goal');
      }
      const res = await sendManagerVerifyEmail({
        pool: app.pool, encKey: app.cfg.encKey, baseUrl: app.cfg.publicBaseUrl,
        tenantId: ctx.tenantId, managerEmail: goal.line_manager_email,
      });
      if (!res.sent) {
        throw new AppError('no_default_sender', 400, 'No default sender configured; cannot send verify email');
      }
      return reply.send({ sent: true });
    } catch (e) { sendError(reply, e); }
  });
```

And the public route (also inside `registerAbeRoutes`, clearly sectioned):

```ts
  // ── Public manager-verify (auth-exempt via /v1/agent/ exclusion; no session) ─────
  app.get('/v1/agent/verify-manager/:token', async (req, reply) => {
    const page = (msg: string) =>
      `<!doctype html><html><body style="font-family:system-ui,sans-serif;text-align:center;padding:48px;color:#1a0f3d"><h2>${msg}</h2></body></html>`;
    try {
      const { token } = req.params as { token: string };
      const parsed = verifyApprovalToken(token, app.cfg.encKey);
      if (!parsed) return reply.code(400).type('text/html').send(page('This confirmation link is invalid or has expired.'));
      const ok = await markManagerVerified(app.pool, parsed.id);
      if (!ok) return reply.code(404).type('text/html').send(page('No matching approver to confirm.'));
      return reply.type('text/html').send(page("Thanks — your email is confirmed. You can now approve or reject campaigns."));
    } catch {
      return reply.code(400).type('text/html').send(page('This confirmation link is invalid or has expired.'));
    }
  });
```

Add the `pg` type import to `agentGoals.ts` only if not already present (it is — `import type pg from 'pg';` is line 1).

- [ ] **Run & expect pass:**

```bash
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.verifyManager.test.ts --no-file-parallelism
```

- [ ] **Commit:**

```bash
git add server/src/routes/abe.ts server/src/repos/agentGoals.ts server/test/abe.verifyManager.test.ts && git commit -m "feat(abe-B2): manager-verify (session send + public verify route)"
```

---

### Task 7 — Escalation hook (`escalatePlay`)

Idempotent: when a play is `pending_approval` and the goal has a verified manager, create the approval row + send the approval email — unless an active approval already exists.

**Files:**
- create: `server/src/agent/abe/escalate.ts`
- create: `server/test/abe.escalate.test.ts`

Steps:

- [ ] **Write the failing test:**

```ts
// server/test/abe.escalate.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createSmtpConfig } from '../src/repos/smtpConfigs.js';
import { createSender } from '../src/repos/senders.js';
import { startTestSmtp } from './helpers/smtp.js';
import { getActiveApprovalByPlay } from '../src/repos/agentApprovals.js';
import { getGoal } from '../src/repos/agentGoals.js';
import type { GoalRow } from '../src/repos/agentGoals.js';
import type { PlayRow } from '../src/repos/agentPlays.js';
import { escalatePlay } from '../src/agent/abe/escalate.js';

const KEY = Buffer.alloc(32, 1);
const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: KEY.toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
  CRON_SECRET: 'c'.repeat(24),
});

let app: Awaited<ReturnType<typeof buildApp>>;
let smtp: ReturnType<typeof startTestSmtp>;
const pool = makePool();

beforeAll(async () => { smtp = startTestSmtp(2533); app = await buildApp({ cfg }); });
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await smtp.close(); await pool.end(); });

async function seed(opts: { verified: boolean; managerEmail: string | null }) {
  const t = await createTenant(pool);
  const sc = await createSmtpConfig(pool, KEY, {
    tenantId: t.id, name: 'local', host: '127.0.0.1', port: 2533, secure: false,
    username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
  });
  await createSender(pool, { tenantId: t.id, email: 'abe@x.com', displayName: 'Abe', smtpConfigId: sc.id });
  const g = await pool.query<GoalRow>(
    `INSERT INTO agent_goals (tenant_id, kind, enabled, line_manager_email, line_manager_verified_at)
     VALUES ($1, 'reengage_dormant', true, $2, $3) RETURNING *`,
    [t.id, opts.managerEmail, opts.verified ? new Date() : null],
  );
  const p = await pool.query<PlayRow>(
    `INSERT INTO agent_plays (tenant_id, goal_id, status, risk_score, audience_snapshot, touches)
     VALUES ($1, $2, 'pending_approval', 50, '{"contact_ids":["c1"],"size":1}',
             '[{"index":0,"subject":"Hi","body_html":"<p>x</p>","scheduled_offset_days":0}]') RETURNING *`,
    [t.id, g.rows[0].id],
  );
  return { tenantId: t.id, goal: g.rows[0], play: p.rows[0] };
}

describe('escalatePlay', () => {
  it('sends an approval email + creates a row when the manager is verified', async () => {
    const { goal, play } = await seed({ verified: true, managerEmail: 'boss@x.io' });
    const res = await escalatePlay({ pool, encKey: cfg.encKey, baseUrl: cfg.publicBaseUrl, play, goal });
    expect(res.escalated).toBe(true);
    expect(await getActiveApprovalByPlay(pool, play.id)).not.toBeNull();
  });

  it('is idempotent — second call does not create a second active approval', async () => {
    const { goal, play } = await seed({ verified: true, managerEmail: 'boss@x.io' });
    await escalatePlay({ pool, encKey: cfg.encKey, baseUrl: cfg.publicBaseUrl, play, goal });
    const second = await escalatePlay({ pool, encKey: cfg.encKey, baseUrl: cfg.publicBaseUrl, play, goal });
    expect(second.escalated).toBe(false);
    expect(second.reason).toBe('already_escalated');
    const rows = await pool.query(`SELECT count(*)::int AS n FROM agent_approvals WHERE play_id = $1`, [play.id]);
    expect(rows.rows[0].n).toBe(1);
  });

  it('is a no-op when the manager is unverified', async () => {
    const { goal, play } = await seed({ verified: false, managerEmail: 'boss@x.io' });
    const res = await escalatePlay({ pool, encKey: cfg.encKey, baseUrl: cfg.publicBaseUrl, play, goal });
    expect(res.escalated).toBe(false);
    expect(res.reason).toBe('manager_unverified');
    expect(await getActiveApprovalByPlay(pool, play.id)).toBeNull();
  });

  it('is a no-op when no manager email is set', async () => {
    const { goal, play } = await seed({ verified: true, managerEmail: null });
    const res = await escalatePlay({ pool, encKey: cfg.encKey, baseUrl: cfg.publicBaseUrl, play, goal });
    expect(res.escalated).toBe(false);
    expect(res.reason).toBe('no_manager_email');
  });
});
```

- [ ] **Run it & expect fail:**

```bash
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.escalate.test.ts --no-file-parallelism
```

- [ ] **Implement** (`server/src/agent/abe/escalate.ts`):

```ts
import type pg from 'pg';
import type { PlayRow } from '../../repos/agentPlays.js';
import type { GoalRow } from '../../repos/agentGoals.js';
import { getActiveApprovalByPlay } from '../../repos/agentApprovals.js';
import { sendApprovalEmail } from './approvalEmail.js';

export type EscalateResult =
  | { escalated: true; emailId: string }
  | { escalated: false; reason: 'no_manager_email' | 'manager_unverified' | 'already_escalated' | 'no_default_sender' };

/**
 * Idempotent escalation: emails the verified line manager an approval link for a
 * pending_approval play and records the approval row. No-op (never throws) for the
 * expected "can't escalate" conditions so the in-app approve/reject fallback stands.
 */
export async function escalatePlay(args: {
  pool: pg.Pool; encKey: Buffer; baseUrl: string; play: PlayRow; goal: GoalRow;
}): Promise<EscalateResult> {
  const { goal, play } = args;
  if (!goal.line_manager_email) return { escalated: false, reason: 'no_manager_email' };
  if (!goal.line_manager_verified_at) return { escalated: false, reason: 'manager_unverified' };

  const existing = await getActiveApprovalByPlay(args.pool, play.id);
  if (existing) return { escalated: false, reason: 'already_escalated' };

  const res = await sendApprovalEmail({
    pool: args.pool, encKey: args.encKey, baseUrl: args.baseUrl,
    tenantId: play.tenant_id, play, managerEmail: goal.line_manager_email,
  });
  if (!res.sent) return { escalated: false, reason: 'no_default_sender' };
  return { escalated: true, emailId: res.emailId! };
}
```

- [ ] **Run & expect pass:**

```bash
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.escalate.test.ts --no-file-parallelism
```

- [ ] **Wire the integration point (B1 Task 8):** In `server/src/agent/abe/shift.ts`, B1 Task 8 adds a tiered decision that, for above-threshold audiences, inserts the play with status `pending_approval` instead of auto-firing. In that `pending_approval` branch, after `insertPlay(...)` returns the play, call:

```ts
import { escalatePlay } from './escalate.js';
// ...inside the pending_approval branch, after `play` is created and `goal` is in scope:
await escalatePlay({ pool, encKey, baseUrl: /* B1 passes publicBaseUrl into runAbeShift */ args.baseUrl, play, goal });
```

If B1's `runAbeShift` signature does not yet thread a `baseUrl`, add `baseUrl: string` to its args (the cron caller in B1 Task 9 passes `app.cfg.publicBaseUrl`). Keep escalation non-fatal: it returns a result, never throws for expected no-ops. **Do not** add a new test for `shift.ts` here — B1 Task 8 owns the shift test; this plan's `escalatePlay` tests cover the behavior. If B1 Task 8 is not yet merged when implementing B2, leave this wiring as the single TODO documented in the B1 Task 8 handoff and proceed — `escalatePlay` is fully usable and tested standalone.

- [ ] **Commit:**

```bash
git add server/src/agent/abe/escalate.ts server/test/abe.escalate.test.ts server/src/agent/abe/shift.ts && git commit -m "feat(abe-B2): idempotent escalatePlay hook + wire into shift pending_approval branch"
```

---

### Task 8 — Public approve/reject/view route

`GET /v1/agent/approve/:token?d=approve|reject|view`. Verifies token (HMAC + expiry), single-use (hash match + `consumed_at IS NULL`), play still `pending_approval`; approve ⇒ `startPlayExecution` + consume + (executor sets executing/approved); reject ⇒ play `rejected` + consume; view ⇒ summary page with Approve/Reject links.

**Files:**
- modify: `server/src/routes/abe.ts`
- modify: `server/src/repos/agentPlays.ts` (add `setPlayStatus` helper)
- create: `server/test/abe.approveRoute.test.ts`

Steps:

- [ ] **Write the failing test** (valid approve, expired token, reused token, reject, view):

```ts
// server/test/abe.approveRoute.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createSmtpConfig } from '../src/repos/smtpConfigs.js';
import { createSender } from '../src/repos/senders.js';
import { startTestSmtp } from './helpers/smtp.js';
import type { PlayRow } from '../src/repos/agentPlays.js';
import { getPlay } from '../src/repos/agentPlays.js';
import { createApproval, getActiveApprovalByPlay } from '../src/repos/agentApprovals.js';
import { signApprovalToken, hashToken } from '../src/agent/abe/approvalToken.js';

const KEY = Buffer.alloc(32, 1);
const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: KEY.toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
  CRON_SECRET: 'c'.repeat(24),
});

let app: Awaited<ReturnType<typeof buildApp>>;
let smtp: ReturnType<typeof startTestSmtp>;
const pool = makePool();

beforeAll(async () => { smtp = startTestSmtp(2534); app = await buildApp({ cfg }); });
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await smtp.close(); await pool.end(); });

// Seeds a pending_approval play + a default sender + an approval row whose token_hash
// matches `token`. Returns { play, token }.
async function seedApproval(expiresMs = Date.now() + 60_000): Promise<{ play: PlayRow; token: string }> {
  const t = await createTenant(pool);
  const sc = await createSmtpConfig(pool, KEY, {
    tenantId: t.id, name: 'local', host: '127.0.0.1', port: 2534, secure: false,
    username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
  });
  await createSender(pool, { tenantId: t.id, email: 'abe@x.com', displayName: 'Abe', smtpConfigId: sc.id });
  const g = await pool.query(
    `INSERT INTO agent_goals (tenant_id, kind, enabled) VALUES ($1, 'reengage_dormant', true) RETURNING id`,
    [t.id],
  );
  const p = await pool.query<PlayRow>(
    `INSERT INTO agent_plays (tenant_id, goal_id, status, risk_score, audience_snapshot, touches)
     VALUES ($1, $2, 'pending_approval', 50, '{"contact_ids":[],"size":0}',
             '[{"index":0,"subject":"Hi","body_html":"<p>x</p>","scheduled_offset_days":0}]') RETURNING *`,
    [t.id, g.rows[0].id],
  );
  const play = p.rows[0];
  const token = signApprovalToken(play.id, expiresMs, KEY);
  await createApproval({
    pool, playId: play.id, tenantId: t.id, tokenHash: hashToken(token),
    managerEmail: 'boss@x.io', expiresAt: new Date(expiresMs),
  });
  return { play, token };
}

const url = (tok: string, d: string) => `/v1/agent/approve/${encodeURIComponent(tok)}?d=${d}`;

describe('public approve/reject/view route', () => {
  it('approve consumes the token and moves the play off pending_approval', async () => {
    const { play, token } = await seedApproval();
    const r = await app.inject({ method: 'GET', url: url(token, 'approve') });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    const after = await getPlay(pool, play.tenant_id, play.id);
    expect(['approved', 'executing', 'done']).toContain(after!.status);
    expect(await getActiveApprovalByPlay(pool, play.id)).toBeNull(); // consumed
  });

  it('reject marks the play rejected and consumes the token', async () => {
    const { play, token } = await seedApproval();
    const r = await app.inject({ method: 'GET', url: url(token, 'reject') });
    expect(r.statusCode).toBe(200);
    const after = await getPlay(pool, play.tenant_id, play.id);
    expect(after!.status).toBe('rejected');
    expect(await getActiveApprovalByPlay(pool, play.id)).toBeNull();
  });

  it('a reused token is rejected (single-use)', async () => {
    const { token } = await seedApproval();
    await app.inject({ method: 'GET', url: url(token, 'approve') });
    const second = await app.inject({ method: 'GET', url: url(token, 'approve') });
    expect(second.statusCode).toBe(400);
  });

  it('an expired token is rejected and the play is untouched', async () => {
    const { play, token } = await seedApproval(Date.now() - 1);
    const r = await app.inject({ method: 'GET', url: url(token, 'approve') });
    expect(r.statusCode).toBe(400);
    const after = await getPlay(pool, play.tenant_id, play.id);
    expect(after!.status).toBe('pending_approval');
  });

  it('view renders the summary without consuming the token', async () => {
    const { play, token } = await seedApproval();
    const r = await app.inject({ method: 'GET', url: url(token, 'view') });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('Approve');
    // still consumable afterwards
    expect(await getActiveApprovalByPlay(pool, play.id)).not.toBeNull();
  });

  it('an invalid decision param is rejected', async () => {
    const { token } = await seedApproval();
    const r = await app.inject({ method: 'GET', url: url(token, 'bogus') });
    expect(r.statusCode).toBe(400);
  });
});
```

- [ ] **Run it & expect fail:**

```bash
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.approveRoute.test.ts --no-file-parallelism
```

- [ ] **Implement step 1** — add a status setter to `server/src/repos/agentPlays.ts` (append; mirrors `insertPlay`'s `PlayRow` return). This is used for the `reject` path; the approve path delegates status changes to `startPlayExecution`:

```ts
export async function setPlayStatus(
  pool: pg.Pool,
  tenantId: string,
  id: string,
  status: PlayStatus,
  rejectionReason?: string | null,
): Promise<PlayRow | null> {
  const r = await pool.query<PlayRow>(
    `UPDATE agent_plays
        SET status = $3, rejection_reason = COALESCE($4, rejection_reason), updated_at = now()
      WHERE tenant_id = $1 AND id = $2
      RETURNING *`,
    [tenantId, id, status, rejectionReason ?? null],
  );
  return r.rows[0] ?? null;
}
```

- [ ] **Implement step 2** — add the public route to `server/src/routes/abe.ts`. Add imports:

```ts
import { hashToken } from '../agent/abe/approvalToken.js';
import { getActiveApprovalByPlay, consumeApproval } from '../repos/agentApprovals.js';
import { setPlayStatus } from '../repos/agentPlays.js';
import { startPlayExecution } from '../agent/abe/execute.js';
```

(`verifyApprovalToken` is already imported from Task 6; `getPlay` is already imported at the top of the file.)

Then add, inside `registerAbeRoutes(app)`:

```ts
  // ── Public approve / reject / view (auth-exempt via /v1/agent/ exclusion) ────────
  app.get('/v1/agent/approve/:token', async (req, reply) => {
    const page = (title: string, body: string) =>
      `<!doctype html><html><body style="font-family:system-ui,sans-serif;text-align:center;padding:48px;color:#1a0f3d;max-width:560px;margin:0 auto"><h2>${title}</h2>${body}</body></html>`;
    const fail = (msg: string) => reply.code(400).type('text/html').send(page('Link unavailable', `<p>${msg}</p>`));

    try {
      const { token } = req.params as { token: string };
      const { d } = req.query as { d?: string };
      if (d !== 'approve' && d !== 'reject' && d !== 'view') return fail('Unrecognised action.');

      const parsed = verifyApprovalToken(token, app.cfg.encKey);
      if (!parsed) return fail('This approval link is invalid or has expired.');

      // parsed.id is the playId. Find the active (unconsumed) approval and validate the hash.
      const approval = await getActiveApprovalByPlay(app.pool, parsed.id);
      if (!approval || approval.token_hash !== hashToken(token)) {
        return fail('This approval link has already been used or is no longer valid.');
      }
      const play = await getPlay(app.pool, approval.tenant_id, parsed.id);
      if (!play || play.status !== 'pending_approval') {
        return fail('This campaign is no longer awaiting approval.');
      }

      if (d === 'view') {
        const audienceSize = play.audience_snapshot.size;
        const touches = play.touches
          .map((t) => `<li>Touch ${t.index + 1} (day ${t.scheduled_offset_days})</li>`)
          .join('');
        const base = `${app.cfg.publicBaseUrl}/v1/agent/approve/${encodeURIComponent(token)}`;
        return reply.type('text/html').send(page(
          'Re-engage campaign',
          `<p>${audienceSize} dormant contact(s), ${play.touches.length} touch(es).</p><ul style="text-align:left;display:inline-block">${touches}</ul>
           <p style="margin-top:24px">
             <a href="${base}?d=approve" style="background:#2e7d32;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;margin-right:8px">Approve</a>
             <a href="${base}?d=reject" style="background:#c62828;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Reject</a>
           </p>`,
        ));
      }

      if (d === 'reject') {
        const consumed = await consumeApproval(app.pool, approval.id, 'reject');
        if (!consumed) return fail('This approval link has already been used.');
        await setPlayStatus(app.pool, approval.tenant_id, play.id, 'rejected', 'Rejected by line manager over email');
        return reply.type('text/html').send(page('Campaign rejected', '<p>Thanks — the campaign will not be sent.</p>'));
      }

      // d === 'approve'. Consume first (single-use guard); a losing race returns null.
      const consumed = await consumeApproval(app.pool, approval.id, 'approve');
      if (!consumed) return fail('This approval link has already been used.');
      await startPlayExecution({ pool: app.pool, encKey: app.cfg.encKey, baseUrl: app.cfg.publicBaseUrl, play });
      return reply.type('text/html').send(page('Campaign approved', '<p>Thanks — Abe is sending the campaign now.</p>'));
    } catch {
      return reply.code(400).type('text/html').send(page('Link unavailable', '<p>Something went wrong with this link.</p>'));
    }
  });
```

- [ ] **Run & expect pass:**

```bash
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.approveRoute.test.ts --no-file-parallelism
```

- [ ] **Commit:**

```bash
git add server/src/routes/abe.ts server/src/repos/agentPlays.ts server/test/abe.approveRoute.test.ts && git commit -m "feat(abe-B2): public approve/reject/view route (single-use, expiring)"
```

---

### Task 9 — Full suite run

**Files:** (none — verification only)

- [ ] **Run the full server suite serially** (expect all green, including the four new B2 test files):

```bash
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run --no-file-parallelism
```

- [ ] If anything fails, debug with superpowers:systematic-debugging before claiming done. Do NOT push (the controller pushes).

---

## Self-Review

### Spec-coverage checklist (B2 scope from the locked spec)
- [ ] HMAC-signed, single-use, expiring links — Task 2 (sign/verify + hash) + Task 3 (`consumed_at` single-use) + Task 8 (hash match + consume).
- [ ] Reuses unsubscribe-link machinery — `sig()` copied verbatim from `marketing/unsubscribe.ts` (Task 2).
- [ ] Index on `agent_approvals.token_hash` — Task 1.
- [ ] Manager-verify: send verify email + public verify route setting `line_manager_verified_at` — Tasks 4 + 6.
- [ ] Approval requires verification — Task 7 (`escalatePlay` returns `manager_unverified` when `line_manager_verified_at IS NULL`).
- [ ] Create `agent_approvals` row + send email when play becomes `pending_approval` — Tasks 4 + 7.
- [ ] Public approve/reject/view routes — Task 8. Approve ⇒ `startPlayExecution`; reject ⇒ `rejected`.
- [ ] No-session decision recording — routes under `/v1/agent/`, excluded in Task 5.
- [ ] Auth-exclusion prefix added — Task 5.
- [ ] From/Reply-To is a real address (default sender) — Task 4 sets both `from` and `reply_to` to `sender.email`.
- [ ] Reply parsing DEFERRED — confirmed: nothing reads replies; `channel='reply'` never written.
- [ ] In-place copy editing DEFERRED — confirmed: `decision='edit'` never written; View only links Approve/Reject.
- [ ] No-block fallback — Task 4/7 return reasons (`no_default_sender`, `no_manager_email`, `manager_unverified`) instead of throwing; play stays `pending_approval`.
- [ ] 7-day expiry + single-use semantics — `TOKEN_TTL_MS` (Task 4); verify rejects `Date.now() > expiresMs` (Task 2); consume guarded by `consumed_at IS NULL` (Task 3/8).

### Placeholder scan
- No `TODO`, no `...`, no "add error handling", no stubbed bodies in any implementation block. Every code step is complete and compilable.
- The one explicitly-conditional step is Task 7's shift wiring: it depends on B1 Task 8 existing. The plan states exactly what to add and what to do if B1 Task 8 is not yet merged — `escalatePlay` itself is fully implemented and tested standalone, so no placeholder leaks into shipped code.

### Type-consistency check
- `verifyApprovalToken` returns `{ id: string; expiresMs: number } | null` — callers use `.id` (playId in Task 8, tenantId in Task 6). Consistent.
- `ApprovalRow.decision` is `'approve'|'reject'|'edit'|null`; `consumeApproval` accepts `ApprovalDecision`; routes pass only `'approve'|'reject'`. Consistent with the DB CHECK in migration 0021.
- `getDefaultSender` is consumed for `sender.email` only — matches B1 Task 3's documented return (`{ email, ... }`). If B1's field is named differently, adjust `sendViaDefault` (single line).
- `SendInputT` requires `from` to be a sender that exists for the tenant (`queueEmail` calls `getSenderByEmail`); the default sender's `email` satisfies this. `reply_to` is an optional field on `SendInputShape` — present, validated as email.
- `PlayStatus` includes `'rejected'` and `'approved'`/`'executing'` — `setPlayStatus` and the approve/reject paths use only declared values.
- `app.cfg.encKey` is `Buffer`, `app.cfg.publicBaseUrl` is `string` — matches `config.ts` (`encKey: Buffer`, `publicBaseUrl: string`) and the `app.cfg.*` usage in `v1Emails.ts`.

### Named verification points for the implementer
1. **B1 prerequisites exist:** confirm `getDefaultSender` (senders.ts), `startPlayExecution` (agent/abe/execute.ts), and the shift `pending_approval` branch (B1 Task 8) are merged before Task 7's wiring. If not, follow the documented fallback in Task 7.
2. **Test SMTP ports:** each new email test uses a distinct port (2531/2532/2533/2534) so parallel-safe even though we run serially. Confirm no collision with existing tests (v1Emails uses 2527).
3. **`startPlayExecution` final status:** the approve test asserts status ∈ {approved, executing, done}. Confirm against B1 Task 6's actual transition; tighten the assertion to the exact value once B1 is known.
4. **Single-use race:** approve consumes *before* calling `startPlayExecution`; a concurrent second click gets `consumeApproval(...) === null` ⇒ 400. Verify the reused-token test passes.
5. **`markManagerVerified` matches one goal per tenant:** relies on the `agent_goals_tenant_kind_uniq` constraint (migration 0021) — one `reengage_dormant` goal per tenant.
6. **HTML injection:** `escapeHtml` is applied to touch subjects in the approval email (Task 4). The View page (Task 8) prints only counts/indices, not user copy — confirm no unescaped tenant text is interpolated there.
