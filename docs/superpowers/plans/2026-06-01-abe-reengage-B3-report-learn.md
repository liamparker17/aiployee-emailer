# Abe Re-engage — Plan B3: REPORT + LEARN Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give Abe a teammate-style activity feed and a light learning loop — aggregate per-play engagement outcomes (opens/clicks/reactivations), surface them via a feed API and the play-detail endpoint, and feed the most recent play's outcome summary back into the next shift's drafting so Abe visibly improves.
**Architecture:** A new `repos/agentOutcomes.ts` aggregates engagement from `emails WHERE play_id` joined to `email_events` (reactivations = distinct audience contacts who open/click within a 14-day attribution window) and writes play-level totals into the touch_index=0 `agent_play_outcomes` row. An `abe-outcomes` cron rolls these up for executing/done plays; a derived `buildFeed` synthesizes first-person entries from `agent_plays` + outcomes (no new table); the play-detail route gains an `outcomes` block; and `lastCompletedPlayOutcome` threads a learning hint into `runAbeShift → draftReengagePlay`.
**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Fastify, node-pg (`pg.Pool`), Vitest against a Neon Postgres test branch, node-pg-migrate (`.cjs`).
**Builds on:** Plan A + Plan B1. **Spec:** docs/superpowers/specs/2026-06-01-agentic-employee-reengage-design.md

---

## Scope / deferred

**In scope (B3):**
- Outcome aggregation query/repo: opens/clicks/uniqueOpens/uniqueClicks/reactivations by `play_id`.
- `updatePlayOutcomes(pool, playId)` — write play-level totals into the touch_index=0 `agent_play_outcomes` row and set `window_closed_at` when the attribution window has fully elapsed.
- `POST /v1/cron/abe-outcomes` — cron-secret-protected roll-up for executing/done plays not yet closed.
- `buildFeed(pool, tenantId)` + `GET /api/agent/feed` — derived first-person Abe entries.
- Extend `GET /api/agent/plays/:id` to return `{ play, outcomes }`.
- LEARN hint: `lastCompletedPlayOutcome(pool, tenantId)` → short string, threaded through `runAbeShift` → `draftReengagePlay` (optional `priorOutcomeHint`).

**Deferred (NOT B3):** reinforcement learning; cross-play trend analytics; any UI rendering (Plan C); free-text reply understanding; per-touch (touch_index > 0) outcome attribution.

---

## Decisions (baked in)

- **`ATTRIBUTION_DAYS = 14`** — a contact in the play's audience counts as a *reactivation* if they have an `open` or `click` `email_event` on a play email (`emails.play_id = play.id`) within 14 days **after that email was sent** (`email_events.created_at <= COALESCE(emails.sent_at, emails.created_at) + interval '14 days'` and `>= COALESCE(emails.sent_at, emails.created_at)`). Defined as a named constant with a comment in `repos/agentOutcomes.ts`.
- **Play-level aggregation (v1).** B1 tags emails with `play_id` but **not** `touch_index` (verified: B1 Task 1 adds only `play_id`; B1 Task 5's `insertEmail` call sets no touch marker). To avoid schema churn we aggregate at the **play** level and store the play-level totals on the **touch_index = 0** outcome row (which B1 always inserts first via `queuePlayTouch(..., touchIndex: 0)`). Per-touch attribution is explicitly deferred. Documented here and in code comments.
- **Reactivation contact match.** `emails.to_addr` ↔ `contacts.email`, **case-insensitive** (`lower(...) = lower(...)`), scoped to the play's tenant; counted as `count(DISTINCT c.id)`. (Mirrors the eligibility join style from B1's `findEligibleContacts`, which also matches `lower(e.to_addr) = lower(c.email)`.)
- **Feed is derived, not stored.** No `agent_activity` table. `buildFeed` fetches plays (+ their touch_index=0 outcome) and synthesizes entries. Entry shape: `{ playId: string, at: string /* ISO */, kind: 'proposed' | 'pending_approval' | 'executed' | 'reported', text: string }`. Reverse-chronological (newest `at` first). `'reported'` entries are emitted only for plays that have a closed/measured outcome and carry the win-back summary text.
- **`window_closed_at`** is set on the touch_index=0 row once `now() >= play.executed_at + (lastTouchIndex * goal.touch_spacing_days days) + ATTRIBUTION_DAYS`. Until then the row is updated in place on each cron pass (numbers can still grow). We read `touch_spacing_days` and the touch count from the play + its goal.

---

## Integration notes / file overlap

- A sibling plan **B2** also edits `routes/abe.ts`, `routes/cron.ts`, and `agent/abe/shift.ts`. These plans execute **sequentially**, so write tasks against the **current post-B1 state** (e.g. `runAbeShift` takes `{ pool, encKey, tenantId, llmFactory, baseUrl }` after B1 Task 8). When implementing, **append** the new route/cron registrations rather than replacing the file; re-run the full suite (Task 7) to confirm no regressions.
- **B1 prerequisites this plan assumes already merged:** migration adding `emails.play_id` (nullable uuid FK) and `agent_plays.executed_at` (timestamptz); `insertEmail` accepting `playId`; `queuePlayTouch` inserting an `agent_play_outcomes` row per touch with `sends` set; `startPlayExecution` setting `executed_at`; `PlayRow.executed_at` present in `repos/agentPlays.ts`.

**Verification point (per the spec brief):** B1 tags emails with `play_id` but NOT `touch_index`. Confirmed against B1 plan Tasks 1 & 5 — no `touch_index` column or value on `emails`. Therefore B3 aggregates at the play level (decision above). If a future plan adds `emails.touch_index`, per-touch rollup becomes a clean follow-up; nothing here blocks it.

---

## Test command convention

Run one file:
```
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/<file> --no-file-parallelism
```
Apply migrations to the test DB:
```
cd server && DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm run migrate
```
Work on `master`. Do **not** push.

---

## Task 1: Outcome aggregation query (`repos/agentOutcomes.ts`)

**Files:**
- Create: `server/src/repos/agentOutcomes.ts`
- Create test: `server/test/abe.outcomes.aggregate.test.ts`

Compute play-level engagement from `emails WHERE play_id = $1` joined to `email_events`, with reactivations = distinct audience contacts who opened/clicked within `ATTRIBUTION_DAYS` of the email's send time. Mirror the correlated-subquery style of `engagementSummary` in `server/src/repos/emailEvents.ts`.

- [ ] **Step 1: Write the failing test** `server/test/abe.outcomes.aggregate.test.ts` (REAL code):

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { aggregatePlayEngagement, ATTRIBUTION_DAYS } from '../src/repos/agentOutcomes.js';

const pool = makePool();

beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

// Minimal sender chain: emails.sender_id and senders.smtp_config_id are NOT NULL.
async function seedSender(tenantId: string): Promise<string> {
  const sc = await pool.query<{ id: string }>(
    `INSERT INTO smtp_configs (tenant_id, name, host, port, username, password_encrypted, from_domain)
     VALUES ($1, 'cfg', 'localhost', 587, 'u', '\\x00'::bytea, 'x.io') RETURNING id`,
    [tenantId],
  );
  const s = await pool.query<{ id: string }>(
    `INSERT INTO senders (tenant_id, email, display_name, smtp_config_id, is_default)
     VALUES ($1, 'abe@x.io', 'Abe', $2, true) RETURNING id`,
    [tenantId, sc.rows[0].id],
  );
  return s.rows[0].id;
}

async function seedGoal(tenantId: string): Promise<string> {
  const g = await pool.query<{ id: string }>(
    `INSERT INTO agent_goals (tenant_id, enabled) VALUES ($1, true) RETURNING id`, [tenantId]);
  return g.rows[0].id;
}

async function seedPlay(tenantId: string, goalId: string): Promise<string> {
  const p = await pool.query<{ id: string }>(
    `INSERT INTO agent_plays (tenant_id, goal_id, status, executed_at, audience_snapshot, touches)
     VALUES ($1, $2, 'done', now() - make_interval(days => 1), '{"contact_ids":[],"size":2}', '[]')
     RETURNING id`,
    [tenantId, goalId],
  );
  return p.rows[0].id;
}

// Insert a play-tagged, already-sent email to a contact; returns the email id.
async function seedSentEmail(
  tenantId: string, senderId: string, playId: string, toAddr: string, sentDaysAgo: number,
): Promise<string> {
  const e = await pool.query<{ id: string }>(
    `INSERT INTO emails (tenant_id, sender_id, to_addr, subject, body_html, status, play_id, sent_at, created_at)
     VALUES ($1, $2, $3, 's', '<p>h</p>', 'sent', $4, now() - make_interval(days => $5), now() - make_interval(days => $5))
     RETURNING id`,
    [tenantId, senderId, toAddr, playId, sentDaysAgo],
  );
  return e.rows[0].id;
}

async function seedEvent(emailId: string, tenantId: string, type: 'open' | 'click', daysAgo: number): Promise<void> {
  await pool.query(
    `INSERT INTO email_events (email_id, tenant_id, type, created_at)
     VALUES ($1, $2, $3, now() - make_interval(days => $4))`,
    [emailId, tenantId, type, daysAgo],
  );
}

async function seedContact(tenantId: string, email: string): Promise<void> {
  await pool.query(`INSERT INTO contacts (tenant_id, email) VALUES ($1, $2)`, [tenantId, email]);
}

describe('aggregatePlayEngagement', () => {
  it('exposes a 14-day attribution constant', () => {
    expect(ATTRIBUTION_DAYS).toBe(14);
  });

  it('counts sends, opens/clicks (total + unique), and reactivations within the window', async () => {
    const t = await createTenant(pool);
    const sender = await seedSender(t.id);
    const goal = await seedGoal(t.id);
    const play = await seedPlay(t.id, goal);

    await seedContact(t.id, 'A@x.io');   // mixed case → case-insensitive match
    await seedContact(t.id, 'b@x.io');
    await seedContact(t.id, 'c@x.io');    // never engaged

    const eA = await seedSentEmail(t.id, sender, play, 'a@x.io', 1); // sent 1 day ago
    const eB = await seedSentEmail(t.id, sender, play, 'b@x.io', 1);
    await seedSentEmail(t.id, sender, play, 'c@x.io', 1);

    // A opens twice (2 opens, 1 unique email) + clicks once → reactivated
    await seedEvent(eA, t.id, 'open', 0);
    await seedEvent(eA, t.id, 'open', 0);
    await seedEvent(eA, t.id, 'click', 0);
    // B opens once → reactivated
    await seedEvent(eB, t.id, 'open', 0);

    const r = await aggregatePlayEngagement(pool, play);
    expect(r.sent).toBe(3);
    expect(r.opens).toBe(3);        // 2 from A + 1 from B
    expect(r.uniqueOpens).toBe(2);  // eA, eB
    expect(r.clicks).toBe(1);
    expect(r.uniqueClicks).toBe(1);
    expect(r.reactivations).toBe(2); // contacts A and B
  });

  it('excludes engagement that falls outside the 14-day window', async () => {
    const t = await createTenant(pool);
    const sender = await seedSender(t.id);
    const goal = await seedGoal(t.id);
    const play = await seedPlay(t.id, goal);
    await seedContact(t.id, 'late@x.io');

    const e = await seedSentEmail(t.id, sender, play, 'late@x.io', 30); // sent 30 days ago
    await seedEvent(e, t.id, 'open', 0); // opened today = 30 days after send → outside window

    const r = await aggregatePlayEngagement(pool, play);
    expect(r.sent).toBe(1);
    expect(r.opens).toBe(1);        // raw opens still counted
    expect(r.reactivations).toBe(0); // but NOT a reactivation (outside attribution window)
  });
});
```

- [ ] **Step 2: Run & expect FAIL** (module does not exist yet):
```
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.outcomes.aggregate.test.ts --no-file-parallelism
```
Expect: failure resolving `../src/repos/agentOutcomes.js`.

- [ ] **Step 3: Implement** `server/src/repos/agentOutcomes.ts` (REAL complete code):

```ts
import type pg from 'pg';

// Attribution window: a dormant contact counts as "reactivated" only if they open or
// click a play email within this many days AFTER that email was sent. 14 days balances
// catching genuine win-backs against attributing unrelated later activity to the play.
export const ATTRIBUTION_DAYS = 14;

export interface PlayEngagement {
  sent: number;
  opens: number;
  uniqueOpens: number;
  clicks: number;
  uniqueClicks: number;
  reactivations: number;
}

/**
 * Play-level engagement for one play, aggregated across ALL its touch emails
 * (emails.play_id = $1). Reactivations = distinct audience contacts (matched
 * case-insensitively on to_addr ↔ contacts.email) with an open/click event dated
 * within ATTRIBUTION_DAYS of the email's send time (sent_at, falling back to created_at).
 * Mirrors the correlated-subquery style of engagementSummary() in repos/emailEvents.ts.
 */
export async function aggregatePlayEngagement(pool: pg.Pool, playId: string): Promise<PlayEngagement> {
  const r = await pool.query<{
    sent: number; opens: number; unique_opens: number; clicks: number; unique_clicks: number; reactivations: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM emails WHERE play_id = $1 AND status IN ('sent','delivered')) AS sent,
       (SELECT count(*)::int FROM email_events ev
          JOIN emails e ON e.id = ev.email_id
          WHERE e.play_id = $1 AND ev.type = 'open') AS opens,
       (SELECT count(DISTINCT ev.email_id)::int FROM email_events ev
          JOIN emails e ON e.id = ev.email_id
          WHERE e.play_id = $1 AND ev.type = 'open') AS unique_opens,
       (SELECT count(*)::int FROM email_events ev
          JOIN emails e ON e.id = ev.email_id
          WHERE e.play_id = $1 AND ev.type = 'click') AS clicks,
       (SELECT count(DISTINCT ev.email_id)::int FROM email_events ev
          JOIN emails e ON e.id = ev.email_id
          WHERE e.play_id = $1 AND ev.type = 'click') AS unique_clicks,
       (SELECT count(DISTINCT c.id)::int
          FROM email_events ev
          JOIN emails e ON e.id = ev.email_id
          JOIN contacts c ON c.tenant_id = e.tenant_id AND lower(c.email) = lower(e.to_addr)
          WHERE e.play_id = $1
            AND ev.type IN ('open','click')
            AND ev.created_at >= COALESCE(e.sent_at, e.created_at)
            AND ev.created_at <= COALESCE(e.sent_at, e.created_at) + make_interval(days => $2)
       ) AS reactivations`,
    [playId, ATTRIBUTION_DAYS],
  );
  const row = r.rows[0];
  return {
    sent: row.sent,
    opens: row.opens,
    uniqueOpens: row.unique_opens,
    clicks: row.clicks,
    uniqueClicks: row.unique_clicks,
    reactivations: row.reactivations,
  };
}
```

- [ ] **Step 4: Run & expect PASS**:
```
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.outcomes.aggregate.test.ts --no-file-parallelism
```
Expect: 3 passed.

- [ ] **Step 5: Commit**:
```
git add server/src/repos/agentOutcomes.ts server/test/abe.outcomes.aggregate.test.ts
git commit -m "feat(abe): aggregatePlayEngagement — play-level opens/clicks/reactivations"
```

---

## Task 2: `updatePlayOutcomes` — write rolled-up numbers + close the window

**Files:**
- Modify: `server/src/repos/agentOutcomes.ts` (add `updatePlayOutcomes`)
- Create test: `server/test/abe.outcomes.update.test.ts`

Write the play-level engagement totals into the **touch_index = 0** `agent_play_outcomes` row (B1 always inserts it). Set `window_closed_at` once the window has fully elapsed for the whole sequence: `now() >= play.executed_at + (lastTouchIndex * touch_spacing_days days) + ATTRIBUTION_DAYS`. Compute `lastTouchIndex = max(0, jsonb_array_length(touches) - 1)` and read `touch_spacing_days` from the play's goal.

- [ ] **Step 1: Write the failing test** `server/test/abe.outcomes.update.test.ts` (REAL code). Reuse the same seed helpers shape as Task 1 (copy `seedSender`/`seedGoal`/`seedContact`/`seedSentEmail`/`seedEvent` into this file; do not import from the test):

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { updatePlayOutcomes } from '../src/repos/agentOutcomes.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function seedSender(tenantId: string): Promise<string> {
  const sc = await pool.query<{ id: string }>(
    `INSERT INTO smtp_configs (tenant_id, name, host, port, username, password_encrypted, from_domain)
     VALUES ($1, 'cfg', 'localhost', 587, 'u', '\\x00'::bytea, 'x.io') RETURNING id`, [tenantId]);
  const s = await pool.query<{ id: string }>(
    `INSERT INTO senders (tenant_id, email, display_name, smtp_config_id, is_default)
     VALUES ($1, 'abe@x.io', 'Abe', $2, true) RETURNING id`, [tenantId, sc.rows[0].id]);
  return s.rows[0].id;
}
async function seedGoal(tenantId: string, spacingDays: number): Promise<string> {
  const g = await pool.query<{ id: string }>(
    `INSERT INTO agent_goals (tenant_id, enabled, touch_spacing_days) VALUES ($1, true, $2) RETURNING id`,
    [tenantId, spacingDays]);
  return g.rows[0].id;
}
// executedDaysAgo controls whether the attribution window has closed.
async function seedExecutingPlay(tenantId: string, goalId: string, executedDaysAgo: number, touchCount: number): Promise<string> {
  const touches = Array.from({ length: touchCount }, (_, i) => ({ index: i, subject: 's', body_html: '<p>h</p>', scheduled_offset_days: i }));
  const p = await pool.query<{ id: string }>(
    `INSERT INTO agent_plays (tenant_id, goal_id, status, executed_at, audience_snapshot, touches)
     VALUES ($1, $2, 'done', now() - make_interval(days => $3), '{"contact_ids":[],"size":1}', $4)
     RETURNING id`,
    [tenantId, goalId, executedDaysAgo, JSON.stringify(touches)]);
  return p.rows[0].id;
}
async function seedOutcomeRow(playId: string, tenantId: string, touchIndex: number, sends: number): Promise<void> {
  await pool.query(
    `INSERT INTO agent_play_outcomes (play_id, tenant_id, touch_index, sends) VALUES ($1, $2, $3, $4)`,
    [playId, tenantId, touchIndex, sends]);
}
async function seedContact(tenantId: string, email: string): Promise<void> {
  await pool.query(`INSERT INTO contacts (tenant_id, email) VALUES ($1, $2)`, [tenantId, email]);
}
async function seedSentEmail(tenantId: string, senderId: string, playId: string, toAddr: string, sentDaysAgo: number): Promise<string> {
  const e = await pool.query<{ id: string }>(
    `INSERT INTO emails (tenant_id, sender_id, to_addr, subject, body_html, status, play_id, sent_at, created_at)
     VALUES ($1, $2, $3, 's', '<p>h</p>', 'sent', $4, now() - make_interval(days => $5), now() - make_interval(days => $5))
     RETURNING id`, [tenantId, senderId, toAddr, playId, sentDaysAgo]);
  return e.rows[0].id;
}
async function seedEvent(emailId: string, tenantId: string, type: 'open' | 'click', daysAgo: number): Promise<void> {
  await pool.query(
    `INSERT INTO email_events (email_id, tenant_id, type, created_at) VALUES ($1, $2, $3, now() - make_interval(days => $4))`,
    [emailId, tenantId, type, daysAgo]);
}

describe('updatePlayOutcomes', () => {
  it('writes play-level numbers into the touch_index=0 row and leaves window open when not elapsed', async () => {
    const t = await createTenant(pool);
    const sender = await seedSender(t.id);
    const goal = await seedGoal(t.id, 3);
    // executed 1 day ago, 2 touches → window closes at executed + 3 + 14 days → still open
    const play = await seedExecutingPlay(t.id, goal, 1, 2);
    await seedOutcomeRow(play, t.id, 0, 1);
    await seedContact(t.id, 'a@x.io');
    const e = await seedSentEmail(t.id, sender, play, 'a@x.io', 1);
    await seedEvent(e, t.id, 'open', 0);

    await updatePlayOutcomes(pool, play);

    const row = await pool.query(
      `SELECT opens, clicks, reactivations, window_closed_at FROM agent_play_outcomes WHERE play_id = $1 AND touch_index = 0`,
      [play]);
    expect(row.rows[0].opens).toBe(1);
    expect(row.rows[0].reactivations).toBe(1);
    expect(row.rows[0].window_closed_at).toBeNull();
  });

  it('sets window_closed_at once the attribution window has fully elapsed', async () => {
    const t = await createTenant(pool);
    const goal = await seedGoal(t.id, 3);
    // executed 60 days ago, 2 touches → executed + 3 + 14 = 17 days ago → window closed
    const play = await seedExecutingPlay(t.id, goal, 60, 2);
    await seedOutcomeRow(play, t.id, 0, 0);

    await updatePlayOutcomes(pool, play);

    const row = await pool.query(
      `SELECT window_closed_at FROM agent_play_outcomes WHERE play_id = $1 AND touch_index = 0`, [play]);
    expect(row.rows[0].window_closed_at).not.toBeNull();
  });

  it('is a no-op (no throw) when no touch_index=0 row exists yet', async () => {
    const t = await createTenant(pool);
    const goal = await seedGoal(t.id, 3);
    const play = await seedExecutingPlay(t.id, goal, 1, 1);
    await expect(updatePlayOutcomes(pool, play)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run & expect FAIL**:
```
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.outcomes.update.test.ts --no-file-parallelism
```
Expect: failure — `updatePlayOutcomes` is not exported.

- [ ] **Step 3: Implement** — append to `server/src/repos/agentOutcomes.ts` (REAL complete code):

```ts
/**
 * Roll up play-level engagement (via aggregatePlayEngagement) into the touch_index = 0
 * agent_play_outcomes row for this play, and stamp window_closed_at once the attribution
 * window has fully elapsed for the whole sequence:
 *   now() >= executed_at + (lastTouchIndex * touch_spacing_days days) + ATTRIBUTION_DAYS
 * No-op if the play has not executed or has no touch_index = 0 outcome row yet.
 */
export async function updatePlayOutcomes(pool: pg.Pool, playId: string): Promise<void> {
  const meta = await pool.query<{
    executed_at: Date | null; touch_spacing_days: number; touch_count: number;
  }>(
    `SELECT p.executed_at,
            g.touch_spacing_days,
            jsonb_array_length(p.touches)::int AS touch_count
       FROM agent_plays p
       JOIN agent_goals g ON g.id = p.goal_id
      WHERE p.id = $1`,
    [playId],
  );
  if (meta.rows.length === 0) return;
  const { executed_at, touch_spacing_days, touch_count } = meta.rows[0];

  const eng = await aggregatePlayEngagement(pool, playId);

  // Window is closed only once the last touch's 14-day window has elapsed.
  let closed = false;
  if (executed_at) {
    const lastTouchIndex = Math.max(0, touch_count - 1);
    const windowEndMs =
      executed_at.getTime() +
      (lastTouchIndex * touch_spacing_days + ATTRIBUTION_DAYS) * 24 * 60 * 60 * 1000;
    closed = Date.now() >= windowEndMs;
  }

  await pool.query(
    `UPDATE agent_play_outcomes
        SET opens = $2,
            clicks = $3,
            reactivations = $4,
            window_closed_at = CASE WHEN $5::boolean THEN COALESCE(window_closed_at, now()) ELSE window_closed_at END,
            updated_at = now()
      WHERE play_id = $1 AND touch_index = 0`,
    [playId, eng.opens, eng.clicks, eng.reactivations, closed],
  );
}
```

- [ ] **Step 4: Run & expect PASS**:
```
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.outcomes.update.test.ts --no-file-parallelism
```
Expect: 3 passed.

- [ ] **Step 5: Commit**:
```
git add server/src/repos/agentOutcomes.ts server/test/abe.outcomes.update.test.ts
git commit -m "feat(abe): updatePlayOutcomes — roll up totals + close attribution window"
```

---

## Task 3: `abe-outcomes` cron — `POST /v1/cron/abe-outcomes`

**Files:**
- Modify: `server/src/routes/cron.ts` (add the route + a `listPlaysForOutcomeRollup` import)
- Modify: `server/src/repos/agentPlays.ts` (add `listPlaysForOutcomeRollup`)
- Create test: `server/test/abe.cron.outcomes.test.ts`

Roll up outcomes for plays that are `executing` or `done` and not yet fully closed. Cron-secret-protected (mirror `abe-shift`); per-play `try/catch`; return `{ ok, plays, updated, errors }`.

- [ ] **Step 1: Add the repo selector** in `server/src/repos/agentPlays.ts` (REAL complete code — append after `listPlays`):

```ts
/**
 * Plays whose outcomes may still change: status executing/done where the touch_index = 0
 * outcome row exists and its window has not been closed yet. Cross-tenant (cron runs globally).
 */
export async function listPlaysForOutcomeRollup(pool: pg.Pool): Promise<Array<{ id: string }>> {
  const r = await pool.query<{ id: string }>(
    `SELECT p.id
       FROM agent_plays p
       JOIN agent_play_outcomes o ON o.play_id = p.id AND o.touch_index = 0
      WHERE p.status IN ('executing','done')
        AND o.window_closed_at IS NULL
      ORDER BY p.executed_at ASC NULLS LAST`,
  );
  return r.rows;
}
```

- [ ] **Step 2: Write the failing cron test** `server/test/abe.cron.outcomes.test.ts` (REAL code; mirror `test/abe.cron.test.ts` for app build + cron-secret header):

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';

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
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await pool.end(); });

async function seedSender(tenantId: string): Promise<string> {
  const sc = await pool.query<{ id: string }>(
    `INSERT INTO smtp_configs (tenant_id, name, host, port, username, password_encrypted, from_domain)
     VALUES ($1, 'cfg', 'localhost', 587, 'u', '\\x00'::bytea, 'x.io') RETURNING id`, [tenantId]);
  const s = await pool.query<{ id: string }>(
    `INSERT INTO senders (tenant_id, email, display_name, smtp_config_id, is_default)
     VALUES ($1, 'abe@x.io', 'Abe', $2, true) RETURNING id`, [tenantId, sc.rows[0].id]);
  return s.rows[0].id;
}

describe('POST /v1/cron/abe-outcomes', () => {
  it('rejects without the cron secret', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/cron/abe-outcomes' });
    expect(res.statusCode).toBe(401);
  });

  it('rolls up outcomes for an executing play', async () => {
    const t = await createTenant(pool);
    const sender = await seedSender(t.id);
    const goal = await pool.query<{ id: string }>(
      `INSERT INTO agent_goals (tenant_id, enabled, touch_spacing_days) VALUES ($1, true, 3) RETURNING id`, [t.id]);
    const play = await pool.query<{ id: string }>(
      `INSERT INTO agent_plays (tenant_id, goal_id, status, executed_at, audience_snapshot, touches)
       VALUES ($1, $2, 'executing', now() - make_interval(days => 1), '{"contact_ids":[],"size":1}',
               '[{"index":0,"subject":"s","body_html":"<p>h</p>","scheduled_offset_days":0}]')
       RETURNING id`, [t.id, goal.rows[0].id]);
    await pool.query(
      `INSERT INTO agent_play_outcomes (play_id, tenant_id, touch_index, sends) VALUES ($1, $2, 0, 1)`,
      [play.rows[0].id, t.id]);
    await pool.query(`INSERT INTO contacts (tenant_id, email) VALUES ($1, 'a@x.io')`, [t.id]);
    const email = await pool.query<{ id: string }>(
      `INSERT INTO emails (tenant_id, sender_id, to_addr, subject, body_html, status, play_id, sent_at)
       VALUES ($1, $2, 'a@x.io', 's', '<p>h</p>', 'sent', $3, now() - make_interval(days => 1)) RETURNING id`,
      [t.id, sender, play.rows[0].id]);
    await pool.query(
      `INSERT INTO email_events (email_id, tenant_id, type) VALUES ($1, $2, 'open')`, [email.rows[0].id, t.id]);

    const res = await app.inject({
      method: 'POST', url: '/v1/cron/abe-outcomes', headers: { 'x-cron-secret': 'c'.repeat(24) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().updated).toBe(1);

    const row = await pool.query(
      `SELECT opens, reactivations FROM agent_play_outcomes WHERE play_id = $1 AND touch_index = 0`,
      [play.rows[0].id]);
    expect(row.rows[0].opens).toBe(1);
    expect(row.rows[0].reactivations).toBe(1);
  });
});
```

- [ ] **Step 3: Run & expect FAIL**:
```
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.cron.outcomes.test.ts --no-file-parallelism
```
Expect: 401 test passes but the roll-up test fails (route 404 / `updated` undefined).

- [ ] **Step 4: Implement** — add imports + the route in `server/src/routes/cron.ts`. Add to the existing import block near the top:

```ts
import { listPlaysForOutcomeRollup } from '../repos/agentPlays.js';
import { updatePlayOutcomes } from '../repos/agentOutcomes.js';
```

Then register the route inside `registerCronRoutes` (append after the `abe-shift` route; do NOT remove existing routes — note B2 may also append here):

```ts
  // POST /v1/cron/abe-outcomes — periodically roll up engagement (opens/clicks/reactivations)
  // for executing/done plays whose attribution window has not yet closed. Mirrors abe-shift.
  app.post('/v1/cron/abe-outcomes', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      requireCronAuth(req, app.cfg.cronSecret);
      const plays = await listPlaysForOutcomeRollup(app.pool);
      let updated = 0;
      const errors: Array<{ playId: string; error: string }> = [];
      for (const p of plays) {
        try {
          await updatePlayOutcomes(app.pool, p.id);
          updated += 1;
        } catch (err) {
          errors.push({ playId: p.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return reply.send({ ok: true, plays: plays.length, updated, errors });
    } catch (e) { sendError(reply, e); }
  });
```

- [ ] **Step 5: Run & expect PASS**:
```
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.cron.outcomes.test.ts --no-file-parallelism
```
Expect: 2 passed.

- [ ] **Step 6: Commit**:
```
git add server/src/repos/agentPlays.ts server/src/routes/cron.ts server/test/abe.cron.outcomes.test.ts
git commit -m "feat(abe): abe-outcomes cron — roll up play engagement on a schedule"
```

---

## Task 4: Feed builder (`agent/abe/feed.ts`) + `GET /api/agent/feed`

**Files:**
- Create: `server/src/agent/abe/feed.ts`
- Modify: `server/src/routes/abe.ts` (add the `GET /api/agent/feed` route + import)
- Create test: `server/test/abe.feed.test.ts`
- Create test: `server/test/abe.routes.feed.test.ts`

Derive reverse-chronological first-person Abe entries from plays + their touch_index=0 outcome. Entry shape: `{ playId, at, kind, text }` with `kind ∈ 'proposed' | 'pending_approval' | 'executed' | 'reported'`.

- [ ] **Step 1: Write the failing builder test** `server/test/abe.feed.test.ts` (REAL code):

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { buildFeed } from '../src/agent/abe/feed.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function seedGoal(tenantId: string): Promise<string> {
  const g = await pool.query<{ id: string }>(
    `INSERT INTO agent_goals (tenant_id, enabled) VALUES ($1, true) RETURNING id`, [tenantId]);
  return g.rows[0].id;
}

describe('buildFeed', () => {
  it('returns [] for a tenant with no plays', async () => {
    const t = await createTenant(pool);
    expect(await buildFeed(pool, t.id)).toEqual([]);
  });

  it('synthesizes a proposed entry for a proposed play', async () => {
    const t = await createTenant(pool);
    const goal = await seedGoal(t.id);
    const p = await pool.query<{ id: string }>(
      `INSERT INTO agent_plays (tenant_id, goal_id, status, audience_snapshot, touches)
       VALUES ($1, $2, 'proposed', '{"contact_ids":[],"size":12}', '[]') RETURNING id`, [t.id, goal]);
    const feed = await buildFeed(pool, t.id);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ playId: p.rows[0].id, kind: 'proposed' });
    expect(feed[0].text).toContain('12');
  });

  it('emits an executed + reported entry (with reactivation %) for a done play with outcomes', async () => {
    const t = await createTenant(pool);
    const goal = await seedGoal(t.id);
    const p = await pool.query<{ id: string }>(
      `INSERT INTO agent_plays (tenant_id, goal_id, status, executed_at, audience_snapshot, touches)
       VALUES ($1, $2, 'done', now() - make_interval(days => 1), '{"contact_ids":[],"size":100}', '[]') RETURNING id`,
      [t.id, goal]);
    await pool.query(
      `INSERT INTO agent_play_outcomes (play_id, tenant_id, touch_index, sends, opens, clicks, reactivations)
       VALUES ($1, $2, 0, 100, 40, 8, 11)`, [p.rows[0].id, t.id]);

    const feed = await buildFeed(pool, t.id);
    const kinds = feed.map((e) => e.kind);
    expect(kinds).toContain('executed');
    expect(kinds).toContain('reported');
    const reported = feed.find((e) => e.kind === 'reported')!;
    expect(reported.text).toContain('11%'); // 11 reactivations / 100 sends
    // reverse-chronological: every entry's `at` is a parseable ISO string, newest first
    const times = feed.map((e) => Date.parse(e.at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});
```

- [ ] **Step 2: Run & expect FAIL**:
```
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.feed.test.ts --no-file-parallelism
```
Expect: failure resolving `../src/agent/abe/feed.js`.

- [ ] **Step 3: Implement** `server/src/agent/abe/feed.ts` (REAL complete code):

```ts
import type pg from 'pg';

export type FeedKind = 'proposed' | 'pending_approval' | 'executed' | 'reported';

export interface FeedEntry {
  playId: string;
  at: string;   // ISO timestamp
  kind: FeedKind;
  text: string; // first-person Abe narration
}

interface FeedRow {
  id: string;
  status: string;
  audience_size: number;
  created_at: Date;
  updated_at: Date;
  executed_at: Date | null;
  sends: number | null;
  opens: number | null;
  reactivations: number | null;
  outcome_updated_at: Date | null;
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

/**
 * Derive a reverse-chronological, first-person activity feed for a tenant from plays and
 * their play-level (touch_index = 0) outcomes. No dedicated activity table (v1 decision):
 * entries are synthesized from play status + timestamps + outcome numbers.
 */
export async function buildFeed(pool: pg.Pool, tenantId: string): Promise<FeedEntry[]> {
  const r = await pool.query<FeedRow>(
    `SELECT p.id,
            p.status,
            (p.audience_snapshot->>'size')::int AS audience_size,
            p.created_at,
            p.updated_at,
            p.executed_at,
            o.sends,
            o.opens,
            o.reactivations,
            o.updated_at AS outcome_updated_at
       FROM agent_plays p
       LEFT JOIN agent_play_outcomes o ON o.play_id = p.id AND o.touch_index = 0
      WHERE p.tenant_id = $1
      ORDER BY p.created_at DESC`,
    [tenantId],
  );

  const entries: FeedEntry[] = [];
  for (const row of r.rows) {
    const size = row.audience_size ?? 0;

    // Always: the moment Abe proposed the play.
    entries.push({
      playId: row.id,
      at: row.created_at.toISOString(),
      kind: 'proposed',
      text: `Abe here — I lined up a win-back for ${size} dormant ${size === 1 ? 'contact' : 'contacts'}.`,
    });

    if (row.status === 'pending_approval') {
      entries.push({
        playId: row.id,
        at: row.updated_at.toISOString(),
        kind: 'pending_approval',
        text: `I sent this win-back to your line manager for sign-off — waiting on approval.`,
      });
    }

    if (row.executed_at) {
      entries.push({
        playId: row.id,
        at: row.executed_at.toISOString(),
        kind: 'executed',
        text: `I started sending the win-back sequence to ${size} ${size === 1 ? 'contact' : 'contacts'}.`,
      });
    }

    // Reported: only once we have measured outcomes (an outcome row with sends recorded).
    if (row.sends != null && row.sends > 0 && row.outcome_updated_at) {
      const reacts = row.reactivations ?? 0;
      const opens = row.opens ?? 0;
      entries.push({
        playId: row.id,
        at: row.outcome_updated_at.toISOString(),
        kind: 'reported',
        text:
          `Update on the last win-back: ${row.sends} sent, ${opens} ${opens === 1 ? 'open' : 'opens'}, ` +
          `${reacts} reactivated (${pct(reacts, row.sends)}%).`,
      });
    }
  }

  entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return entries;
}
```

- [ ] **Step 4: Run & expect PASS**:
```
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.feed.test.ts --no-file-parallelism
```
Expect: 3 passed.

- [ ] **Step 5: Write the failing route test** `server/test/abe.routes.feed.test.ts` (REAL code; mirror `test/abe.routes.test.ts` admin-session helper):

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant, createUser } from './helpers/factories.js';
import { csrfFor, login } from './helpers/auth.js';

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
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await pool.end(); });

async function adminSession() {
  const t = await createTenant(pool);
  const password = 'pw-12345678';
  await createUser(pool, { tenantId: t.id, email: 'admin@x.io', password, role: 'tenant_admin' });
  const csrf = await csrfFor(app);
  const headers = await login(app, { email: 'admin@x.io', password }, csrf);
  return { tenantId: t.id, headers };
}

describe('GET /api/agent/feed', () => {
  it('requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agent/feed' });
    expect(res.statusCode).toBe(401);
  });

  it('returns derived feed entries for the tenant', async () => {
    const { tenantId, headers } = await adminSession();
    const goal = await pool.query<{ id: string }>(
      `INSERT INTO agent_goals (tenant_id, enabled) VALUES ($1, true) RETURNING id`, [tenantId]);
    await pool.query(
      `INSERT INTO agent_plays (tenant_id, goal_id, status, audience_snapshot, touches)
       VALUES ($1, $2, 'proposed', '{"contact_ids":[],"size":7}', '[]')`, [tenantId, goal.rows[0].id]);

    const res = await app.inject({ method: 'GET', url: '/api/agent/feed', headers });
    expect(res.statusCode).toBe(200);
    const feed = res.json().feed;
    expect(Array.isArray(feed)).toBe(true);
    expect(feed[0].kind).toBe('proposed');
    expect(feed[0].text).toContain('7');
  });
});
```

- [ ] **Step 6: Run & expect FAIL**:
```
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.routes.feed.test.ts --no-file-parallelism
```
Expect: the "returns derived feed entries" test fails (route 404). (The 401 test may already pass if unknown routes 404 — if it returns 404 instead of 401, that is acceptable for an unregistered route; adjust the assertion to `expect([401,404]).toContain(res.statusCode)` ONLY if needed after Step 8 confirms the registered route returns 401 unauthenticated.)

- [ ] **Step 7: Implement** — add to `server/src/routes/abe.ts`. Extend the import from agentPlays is not needed here; add a new import and route. Add near the top imports:

```ts
import { buildFeed } from '../agent/abe/feed.js';
```

Register inside `registerAbeRoutes` (append after the `GET /api/agent/plays/:id` route):

```ts
  app.get('/api/agent/feed', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const feed = await buildFeed(app.pool, ctx.tenantId);
      return reply.send({ feed });
    } catch (e) { sendError(reply, e); }
  });
```

- [ ] **Step 8: Run & expect PASS**:
```
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.routes.feed.test.ts --no-file-parallelism
```
Expect: 2 passed. (`requireTenantCtx` throws an `AppError('unauthorized', 401, ...)` for no session — confirm the 401 assertion holds; it mirrors the existing abe routes.)

- [ ] **Step 9: Commit**:
```
git add server/src/agent/abe/feed.ts server/src/routes/abe.ts server/test/abe.feed.test.ts server/test/abe.routes.feed.test.ts
git commit -m "feat(abe): derived activity feed (buildFeed) + GET /api/agent/feed"
```

---

## Task 5: Extend `GET /api/agent/plays/:id` with `{ play, outcomes }`

**Files:**
- Modify: `server/src/repos/agentOutcomes.ts` (add `getPlayOutcomes`)
- Modify: `server/src/routes/abe.ts` (extend the `:id` handler)
- Create test: `server/test/abe.routes.playDetail.test.ts`

- [ ] **Step 1: Add the repo reader** in `server/src/repos/agentOutcomes.ts` (REAL complete code — append):

```ts
export interface PlayOutcomeRow {
  id: string;
  play_id: string;
  tenant_id: string;
  touch_index: number;
  sends: number;
  opens: number;
  clicks: number;
  reactivations: number;
  window_closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** All outcome rows for a play (tenant-scoped), ordered by touch index. */
export async function getPlayOutcomes(pool: pg.Pool, tenantId: string, playId: string): Promise<PlayOutcomeRow[]> {
  const r = await pool.query<PlayOutcomeRow>(
    `SELECT * FROM agent_play_outcomes
      WHERE tenant_id = $1 AND play_id = $2
      ORDER BY touch_index ASC`,
    [tenantId, playId],
  );
  return r.rows;
}
```

- [ ] **Step 2: Write the failing test** `server/test/abe.routes.playDetail.test.ts` (REAL code; admin-session helper as in Task 4 Step 5):

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant, createUser } from './helpers/factories.js';
import { csrfFor, login } from './helpers/auth.js';

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
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await pool.end(); });

async function adminSession() {
  const t = await createTenant(pool);
  const password = 'pw-12345678';
  await createUser(pool, { tenantId: t.id, email: 'admin@x.io', password, role: 'tenant_admin' });
  const csrf = await csrfFor(app);
  const headers = await login(app, { email: 'admin@x.io', password }, csrf);
  return { tenantId: t.id, headers };
}

describe('GET /api/agent/plays/:id with outcomes', () => {
  it('returns the play plus its outcome rows', async () => {
    const { tenantId, headers } = await adminSession();
    const goal = await pool.query<{ id: string }>(
      `INSERT INTO agent_goals (tenant_id, enabled) VALUES ($1, true) RETURNING id`, [tenantId]);
    const play = await pool.query<{ id: string }>(
      `INSERT INTO agent_plays (tenant_id, goal_id, status, audience_snapshot, touches)
       VALUES ($1, $2, 'done', '{"contact_ids":[],"size":3}', '[]') RETURNING id`, [tenantId, goal.rows[0].id]);
    await pool.query(
      `INSERT INTO agent_play_outcomes (play_id, tenant_id, touch_index, sends, opens, reactivations)
       VALUES ($1, $2, 0, 3, 2, 1)`, [play.rows[0].id, tenantId]);

    const res = await app.inject({ method: 'GET', url: `/api/agent/plays/${play.rows[0].id}`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().play.id).toBe(play.rows[0].id);
    expect(Array.isArray(res.json().outcomes)).toBe(true);
    expect(res.json().outcomes[0].sends).toBe(3);
    expect(res.json().outcomes[0].reactivations).toBe(1);
  });

  it('404s for an unknown play', async () => {
    const { headers } = await adminSession();
    const res = await app.inject({
      method: 'GET', url: '/api/agent/plays/00000000-0000-0000-0000-000000000000', headers });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 3: Run & expect FAIL**:
```
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.routes.playDetail.test.ts --no-file-parallelism
```
Expect: the "returns the play plus its outcome rows" test fails (`outcomes` is undefined).

- [ ] **Step 4: Implement** — in `server/src/routes/abe.ts`, add the import and extend the handler. Add to the agentOutcomes import (new line):

```ts
import { getPlayOutcomes } from '../repos/agentOutcomes.js';
```

Replace the body of the existing `GET /api/agent/plays/:id` handler so it also fetches outcomes:

```ts
  app.get('/api/agent/plays/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const play = await getPlay(app.pool, ctx.tenantId, id);
      if (!play) throw new AppError('not_found', 404, 'Play not found');
      const outcomes = await getPlayOutcomes(app.pool, ctx.tenantId, id);
      return reply.send({ play, outcomes });
    } catch (e) { sendError(reply, e); }
  });
```

- [ ] **Step 5: Run & expect PASS**:
```
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.routes.playDetail.test.ts --no-file-parallelism
```
Expect: 2 passed.

- [ ] **Step 6: Commit**:
```
git add server/src/repos/agentOutcomes.ts server/src/routes/abe.ts server/test/abe.routes.playDetail.test.ts
git commit -m "feat(abe): play detail returns outcomes (getPlayOutcomes)"
```

---

## Task 6: LEARN hint — thread last completed play's outcome into the next shift

**Files:**
- Modify: `server/src/repos/agentOutcomes.ts` (add `lastCompletedPlayOutcome`)
- Modify: `server/src/agent/abe/draftPlay.ts` (accept optional `priorOutcomeHint`)
- Modify: `server/src/agent/abe/shift.ts` (fetch hint, pass it through)
- Create test: `server/test/abe.outcomes.learnHint.test.ts`
- Modify test: `server/test/abe.draftPlay.test.ts` (assert the hint reaches the prompt; existing tests still pass)

`lastCompletedPlayOutcome` returns a short string (or null) summarizing the most recent `done` play's measured win-back; `draftReengagePlay` appends it to the user prompt when provided; `runAbeShift` fetches and passes it.

- [ ] **Step 1: Write the failing repo test** `server/test/abe.outcomes.learnHint.test.ts` (REAL code):

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { lastCompletedPlayOutcome } from '../src/repos/agentOutcomes.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function seedGoal(tenantId: string): Promise<string> {
  const g = await pool.query<{ id: string }>(
    `INSERT INTO agent_goals (tenant_id, enabled) VALUES ($1, true) RETURNING id`, [tenantId]);
  return g.rows[0].id;
}

describe('lastCompletedPlayOutcome', () => {
  it('returns null when the tenant has no completed plays with outcomes', async () => {
    const t = await createTenant(pool);
    expect(await lastCompletedPlayOutcome(pool, t.id)).toBeNull();
  });

  it('summarizes the most recent done play that has recorded sends', async () => {
    const t = await createTenant(pool);
    const goal = await seedGoal(t.id);
    const play = await pool.query<{ id: string }>(
      `INSERT INTO agent_plays (tenant_id, goal_id, status, executed_at, audience_snapshot, touches)
       VALUES ($1, $2, 'done', now() - make_interval(days => 5), '{"contact_ids":[],"size":50}', '[]') RETURNING id`,
      [t.id, goal]);
    await pool.query(
      `INSERT INTO agent_play_outcomes (play_id, tenant_id, touch_index, sends, opens, reactivations)
       VALUES ($1, $2, 0, 50, 20, 6)`, [play.rows[0].id, t.id]);

    const hint = await lastCompletedPlayOutcome(pool, t.id);
    expect(hint).not.toBeNull();
    expect(hint!).toContain('50');
    expect(hint!).toContain('12%'); // 6 / 50 reactivated
  });
});
```

- [ ] **Step 2: Run & expect FAIL**:
```
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.outcomes.learnHint.test.ts --no-file-parallelism
```
Expect: failure — `lastCompletedPlayOutcome` not exported.

- [ ] **Step 3: Implement** `lastCompletedPlayOutcome` — append to `server/src/repos/agentOutcomes.ts` (REAL complete code):

```ts
/**
 * A short, first-person-free learning hint summarizing the tenant's most recent completed
 * (status 'done') play that has recorded sends. Fed into the NEXT shift's drafting so Abe
 * can reference how the last win-back performed. Returns null if there is nothing to learn from.
 */
export async function lastCompletedPlayOutcome(pool: pg.Pool, tenantId: string): Promise<string | null> {
  const r = await pool.query<{ sends: number; opens: number; reactivations: number }>(
    `SELECT o.sends, o.opens, o.reactivations
       FROM agent_plays p
       JOIN agent_play_outcomes o ON o.play_id = p.id AND o.touch_index = 0
      WHERE p.tenant_id = $1 AND p.status = 'done' AND o.sends > 0
      ORDER BY p.executed_at DESC NULLS LAST, p.created_at DESC
      LIMIT 1`,
    [tenantId],
  );
  if (r.rows.length === 0) return null;
  const { sends, opens, reactivations } = r.rows[0];
  const reactPct = sends > 0 ? Math.round((reactivations / sends) * 100) : 0;
  const openPct = sends > 0 ? Math.round((opens / sends) * 100) : 0;
  return `Your last win-back reached ${sends} contacts; ${openPct}% opened and ${reactPct}% reactivated.`;
}
```

- [ ] **Step 4: Run & expect PASS**:
```
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.outcomes.learnHint.test.ts --no-file-parallelism
```
Expect: 2 passed.

- [ ] **Step 5: Extend `abe.draftPlay.test.ts`** — add a capturing-stub test that asserts the hint reaches the user prompt. Append this `it` inside the existing `describe('draftReengagePlay', ...)` block in `server/test/abe.draftPlay.test.ts` (REAL code):

```ts
  it('appends the prior-outcome learning hint to the user prompt when provided', async () => {
    let captured = '';
    const capturingLlm = {
      chat: async (args: { model: string; messages: Array<{ role: string; content: string }> }) => {
        captured = args.messages.find((m) => m.role === 'user')?.content ?? '';
        return { content: JSON.stringify({ touches: [{ subject: 's', body_html: '<p>h</p>' }] }), toolCalls: [] };
      },
    };
    await draftReengagePlay({
      llm: capturingLlm, model: 'gpt-4.1', brandVoice: null,
      maxTouches: 3, touchSpacingDays: 3, audienceSize: 10,
      priorOutcomeHint: 'Your last win-back reached 50 contacts; 40% opened and 12% reactivated.',
    });
    expect(captured).toContain('Your last win-back reached 50 contacts');
  });
```

- [ ] **Step 6: Run & expect FAIL** (the new arg is not accepted yet / hint not in prompt):
```
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.draftPlay.test.ts --no-file-parallelism
```
Expect: the new test fails (`priorOutcomeHint` not in the `user` string); a TS error on the unknown property is also acceptable as the failure.

- [ ] **Step 7: Implement** — modify `server/src/agent/abe/draftPlay.ts`. Add `priorOutcomeHint` to the args type and append it to the `user` string. The full updated `draftReengagePlay` signature + prompt build (REAL complete code — replace the args type and the `user` construction):

```ts
export async function draftReengagePlay(args: {
  llm: LlmClient;
  model: string;
  brandVoice: string | null;
  maxTouches: number;
  touchSpacingDays: number;
  audienceSize: number;
  priorOutcomeHint?: string | null;
}): Promise<Touch[]> {
  const user =
    `Audience: ${args.audienceSize} dormant contacts. ` +
    `Produce at most ${args.maxTouches} touches. ` +
    (args.brandVoice ? `Brand voice to match: ${args.brandVoice}. ` : '') +
    (args.priorOutcomeHint ? `For context, how your last win-back performed: ${args.priorOutcomeHint} ` : '') +
    `Each touch needs a "subject" and an HTML "body_html".`;
```

(Leave the rest of the function — `messages`, `llm.chat`, parsing — unchanged.)

- [ ] **Step 8: Run & expect PASS**:
```
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.draftPlay.test.ts --no-file-parallelism
```
Expect: 3 passed (2 existing + 1 new).

- [ ] **Step 9: Thread the hint through `runAbeShift`** — modify `server/src/agent/abe/shift.ts`. Add the import and fetch the hint before drafting, then pass it to `draftReengagePlay`. Add to the imports:

```ts
import { lastCompletedPlayOutcome } from '../../repos/agentOutcomes.js';
```

Replace the `draftReengagePlay({ ... })` call so it includes the hint (REAL complete code):

```ts
  const priorOutcomeHint = await lastCompletedPlayOutcome(pool, tenantId);

  const touches = await draftReengagePlay({
    llm: args.llmFactory(apiKey),
    model,
    brandVoice: goal.brand_voice,
    maxTouches: goal.max_touches,
    touchSpacingDays: goal.touch_spacing_days,
    audienceSize: dormant.length,
    priorOutcomeHint,
  });
```

(Note: if B2 has already added other fields to this call, keep them — only add `priorOutcomeHint`. The field is optional/nullable so existing `runAbeShift`/`shift.test.ts` behavior is unchanged when there is no completed play.)

- [ ] **Step 10: Run & expect PASS** (shift tests still green — hint is null with no prior `done` play):
```
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.shift.test.ts --no-file-parallelism
```
Expect: all existing shift tests pass.

- [ ] **Step 11: Commit**:
```
git add server/src/repos/agentOutcomes.ts server/src/agent/abe/draftPlay.ts server/src/agent/abe/shift.ts server/test/abe.outcomes.learnHint.test.ts server/test/abe.draftPlay.test.ts
git commit -m "feat(abe): LEARN — feed last play's outcome hint into next shift's drafting"
```

---

## Task 7: Full suite run

**Files:** none (verification only).

- [ ] **Step 1: Run the full server test suite serially**:
```
cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run --no-file-parallelism
```
Expect: all tests pass (new B3 files + all pre-existing). If any pre-existing abe test regressed, fix the integration point (most likely an additive route registration order or the `draftReengagePlay` call) before proceeding.

- [ ] **Step 2: TypeScript build check** (catch type drift across the modified files):
```
cd server && npx tsc --noEmit
```
Expect: no errors.

- [ ] **Step 3: Commit** (only if Step 1/2 surfaced and you fixed anything; otherwise skip):
```
git add -A
git commit -m "test(abe): B3 full-suite green"
```

---

## Self-Review

**Spec coverage (B3 brief → tasks):**
- Outcome aggregation (opens/clicks/reactivations by `play_id`, written into `agent_play_outcomes`) → Tasks 1 & 2.
- `abe-outcomes` cron filling numbers within an attribution window → Task 3 (`ATTRIBUTION_DAYS = 14`).
- Feed API `GET /api/agent/feed` → Task 4.
- Extend play-detail endpoint with outcomes → Task 5.
- Feed most-recent completed play's outcome summary into `runAbeShift → draftReengagePlay` → Task 6.
- Deferred (RL, cross-play trends, UI) → stated in Scope and not implemented.

**Placeholder scan:** No `TODO`/`FIXME`/`...`/`<placeholder>` tokens. Every code step contains complete, compilable code. Patterns reused are named to the exact mirror file: aggregation style ← `repos/emailEvents.ts` `engagementSummary`; cron auth/shape ← `routes/cron.ts` `abe-shift`; session route ← `routes/abe.ts` existing handlers; test harness ← `test/abe.cron.test.ts` and `test/abe.routes.test.ts`; sender/contact seeding ← real schemas in `migrations/1700000000002_smtp_senders.cjs`, `1700000000017_contacts_lists.cjs`, `1700000000004_emails_bounces_suppressions.cjs`.

**Type consistency:**
- `PlayEngagement` fields (`sent/opens/uniqueOpens/clicks/uniqueClicks/reactivations`) match the snake→camel mapping done in the repo.
- `aggregatePlayEngagement` return is consumed by `updatePlayOutcomes` (uses `opens`, `clicks`, `reactivations`) and the cron — consistent.
- `FeedEntry.kind` union (`'proposed'|'pending_approval'|'executed'|'reported'`) matches the documented decision and the builder's emitted kinds.
- `getPlayOutcomes` returns `PlayOutcomeRow[]` matching the `agent_play_outcomes` columns from `migrations/1700000000021_abe.cjs` (verified column names: `sends/opens/clicks/reactivations/window_closed_at/touch_index`).
- `draftReengagePlay` arg gains optional `priorOutcomeHint?: string | null`; `runAbeShift` passes `string | null` from `lastCompletedPlayOutcome` — assignable.
- `LlmMessage`/`LlmTurn` shapes (from `agent/runner.ts`) honored by the capturing stub in the draftPlay test.

**Named verification points:**
1. **No `touch_index` on emails** — confirmed against B1 plan Tasks 1 & 5; play-level aggregation chosen and stored on `touch_index = 0` (the row B1 inserts first). Re-verify when implementing: open `server/src/repos/emails.ts` `insertEmail` to confirm no touch column was added by B1.
2. **`agent_plays.executed_at` exists** — added by B1 Task 1; `updatePlayOutcomes`, `buildFeed`, and `lastCompletedPlayOutcome` read it. Verify `PlayRow.executed_at` is present in `repos/agentPlays.ts` after B1 merges (it is absent in the pre-B1 snapshot).
3. **`email_events` has no per-send timestamp** — only its own `created_at`. The attribution window therefore anchors on `emails.sent_at` (fallback `created_at`). Verified against `migrations/1700000000015_email_events.cjs` and `...004...cjs`.
4. **`requireTenantCtx` 401 behavior** — the feed/play-detail routes rely on it throwing `AppError(...,401)`; mirror existing abe routes. If an unauthenticated request to an unregistered path returns 404 instead, that only affects the pre-implementation FAIL step, not the final PASS (Task 4 Step 8 note).
5. **Additive edits to shared files** — `routes/abe.ts`, `routes/cron.ts`, `agent/abe/shift.ts` are also touched by sibling Plan B2. Append rather than replace, and run the full suite (Task 7) to catch any registration-order or call-shape conflicts.
6. **`bytea` seed literal** — tests seed `smtp_configs.password_encrypted` with `'\\x00'::bytea`; valid Postgres hex bytea. Confirm no NOT-NULL/length constraint beyond what the schema shows.
