# Abe Re-engage — Plan B1: ACT (execute the play) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a `proposed` play into actual re-engagement emails: auto-fire low-risk plays, gate higher-risk ones behind in-app approval, fan out the touch sequence through the existing send pipeline (tagged with `play_id`), and send later touches on a schedule while **auto-skipping contacts who re-engaged**.

**Architecture:** Reuse the campaign-send pattern — one `emails` row per contact per touch, `status='queued'` with `scheduled_for`, dispatched by the existing `process-queue` cron. Tag each row with a new nullable `play_id` (mirrors `campaign_id`) so B3 can measure outcomes. A new `abe-touches` cron advances each executing play through its touches, recomputing eligibility (skip suppressed/unsubscribed/re-engaged) at each touch.

**Tech Stack:** Fastify + TypeScript, raw `pg`, node-pg-migrate (`.cjs`), Zod, Vitest (`app.inject` + DB), reuse `send/pipeline`, `repos/emails`, `repos/senders`, `marketing/unsubscribe` (signUnsubToken), `repos/contacts`.

**Builds on:** Plan A (shipped — `agent_goals`/`agent_plays`/`agent_play_outcomes`, `runAbeShift` creating `proposed` plays). **Spec:** `docs/superpowers/specs/2026-06-01-agentic-employee-reengage-design.md`.

**Scope of B1 / deferred:**
- **In B1:** `play_id` on emails; `getDefaultSender`; eligibility filter (skip suppressed/unsubscribed/re-engaged); queue a touch's emails; start execution (auto-fire or on approve); in-app `approve`/`reject` endpoints; tiered auto-fire wired into the shift; the `abe-touches` scheduler cron.
- **Deferred to B2:** approval-over-email (manager verify, signed token, approval email, public routes). For B1, escalated plays simply wait in `pending_approval` for the in-app approve/reject endpoints.
- **Deferred to B3:** REPORT (activity feed) and LEARN (outcome aggregation/surfacing).

**Decisions (B1):**
- **Sender:** Abe sends from the tenant's **default sender** (`senders.is_default = true`). No default sender ⇒ a play cannot execute (skip reason `no_sender`). Explicit per-goal sender selection is deferred to Plan C onboarding.
- **Touch scheduling:** touch 0 is queued the moment a play starts executing; touches 1..n are queued by the `abe-touches` cron when due (`now >= executed_at + touchIndex * touch_spacing_days`). Eligibility is recomputed per touch, so re-engaged contacts drop out mid-sequence.
- **Re-engaged** (for skipping later touches) = the contact has an `open`/`click` event dated at/after the play's `executed_at`.
- **Compliance:** every touch email carries the same HMAC unsubscribe link + footer as campaigns (mirror `marketing/campaignSend.ts`).

---

### Task 1: Migration — `emails.play_id` + `agent_plays.executed_at`

**Files:**
- Create: `server/migrations/<N+1>_abe_act.cjs` (prefix one greater than the highest existing; the Abe schema migration was `1700000000021_abe.cjs`).

- [ ] **Step 1: Find the next migration number** — list `server/migrations`, take highest prefix + 1.

- [ ] **Step 2: Write the migration**

```js
/* eslint-disable camelcase */
// Abe ACT: link sent emails to a play (for outcome measurement) + record when execution began.
exports.up = (pgm) => {
  pgm.addColumn('emails', {
    play_id: { type: 'uuid', references: 'agent_plays(id)', onDelete: 'SET NULL' },
  });
  pgm.createIndex('emails', ['play_id'], { where: 'play_id IS NOT NULL', name: 'emails_play_id_idx' });
  pgm.addColumn('agent_plays', {
    executed_at: { type: 'timestamptz' },
  });
};
exports.down = (pgm) => {
  pgm.dropColumn('agent_plays', 'executed_at');
  pgm.dropIndex('emails', ['play_id'], { name: 'emails_play_id_idx' });
  pgm.dropColumn('emails', 'play_id');
};
```

- [ ] **Step 3: Apply** — `cd server && DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm run migrate`. Expected: clean apply. (Test branch only — never prod.)

- [ ] **Step 4: Commit**
```bash
git add server/migrations/
git commit -m "feat(abe): migration — emails.play_id + agent_plays.executed_at"
```

---

### Task 2: Extend `insertEmail` with optional `playId`

**Files:**
- Modify: `server/src/repos/emails.ts` (the `insertEmail` function)
- Test: `server/test/abe.insertEmail.playid.test.ts`

- [ ] **Step 1: Read `insertEmail`** (scoped) to learn its exact arg object shape (campaignSend calls it with `{ tenantId, senderId, toAddr, subject, bodyHtml, status, scheduledFor, campaignId, listUnsubscribe }`). Confirm the exact property names and the column list in its INSERT.

- [ ] **Step 2: Write the failing test** `server/test/abe.insertEmail.playid.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { insertEmail } from '../src/repos/emails.js';
import { upsertGoal } from '../src/repos/agentGoals.js';
import { insertPlay } from '../src/repos/agentPlays.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function sender(tenantId: string) {
  const cfg = await pool.query(
    `INSERT INTO smtp_configs (tenant_id, name, host, port, secure, username, password_encrypted, from_domain)
     VALUES ($1,'c','h',25,false,'u','\\x00','x.io') RETURNING id`, [tenantId]);
  const s = await pool.query(
    `INSERT INTO senders (tenant_id, email, display_name, smtp_config_id, is_default)
     VALUES ($1,'from@x.io','X',$2,true) RETURNING id`, [tenantId, cfg.rows[0].id]);
  return s.rows[0].id as string;
}

describe('insertEmail playId', () => {
  it('persists play_id when provided', async () => {
    const t = await createTenant(pool);
    const sid = await sender(t.id);
    const g = await upsertGoal(pool, t.id, { enabled: true });
    const play = await insertPlay(pool, { tenantId: t.id, goalId: g.id, riskScore: 1, audienceSnapshot: { contact_ids: [], size: 0 }, touches: [] });
    const email = await insertEmail(pool, {
      tenantId: t.id, senderId: sid, toAddr: 'a@x.io', subject: 's', bodyHtml: '<p>b</p>', status: 'queued', playId: play.id,
    });
    const row = await pool.query(`SELECT play_id FROM emails WHERE id = $1`, [email.id]);
    expect(row.rows[0].play_id).toBe(play.id);
  });

  it('leaves play_id null when omitted (back-compat)', async () => {
    const t = await createTenant(pool);
    const sid = await sender(t.id);
    const email = await insertEmail(pool, {
      tenantId: t.id, senderId: sid, toAddr: 'a@x.io', subject: 's', bodyHtml: '<p>b</p>', status: 'queued',
    });
    const row = await pool.query(`SELECT play_id FROM emails WHERE id = $1`, [email.id]);
    expect(row.rows[0].play_id).toBeNull();
  });
});
```
(Adjust `sender()` columns if the smtp_configs/senders schema differs — read `1700000000002_smtp_senders.cjs`.)

- [ ] **Step 3: Implement** — add `playId?: string | null` to the `insertEmail` args type, add `play_id` to the INSERT column list and a `$N` for `args.playId ?? null`. Change nothing else about existing behavior.

- [ ] **Step 4: Run** `cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.insertEmail.playid.test.ts --no-file-parallelism` → 2 passed.

- [ ] **Step 5: Commit**
```bash
git add server/src/repos/emails.ts server/test/abe.insertEmail.playid.test.ts
git commit -m "feat(abe): insertEmail accepts optional playId"
```

---

### Task 3: `getDefaultSender`

**Files:**
- Modify: `server/src/repos/senders.ts`
- Test: `server/test/abe.defaultSender.test.ts`

- [ ] **Step 1: Failing test** `server/test/abe.defaultSender.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { getDefaultSender } from '../src/repos/senders.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function addSender(tenantId: string, email: string, isDefault: boolean) {
  const cfg = await pool.query(
    `INSERT INTO smtp_configs (tenant_id, name, host, port, secure, username, password_encrypted, from_domain)
     VALUES ($1,'c','h',25,false,'u','\\x00','x.io') RETURNING id`, [tenantId]);
  await pool.query(
    `INSERT INTO senders (tenant_id, email, display_name, smtp_config_id, is_default)
     VALUES ($1,$2,'X',$3,$4)`, [tenantId, email, cfg.rows[0].id, isDefault]);
}

describe('getDefaultSender', () => {
  it('returns the default sender, or null when none', async () => {
    const t = await createTenant(pool);
    expect(await getDefaultSender(pool, t.id)).toBeNull();
    await addSender(t.id, 'a@x.io', false);
    await addSender(t.id, 'b@x.io', true);
    const d = await getDefaultSender(pool, t.id);
    expect(d?.email).toBe('b@x.io');
  });
});
```

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement** — add to `senders.ts` (reuse the existing `Sender` interface):
```ts
export async function getDefaultSender(pool: pg.Pool, tenantId: string): Promise<Sender | null> {
  const r = await pool.query<Sender>(
    `SELECT * FROM senders WHERE tenant_id = $1 AND is_default = true ORDER BY created_at ASC LIMIT 1`,
    [tenantId],
  );
  return r.rows[0] ?? null;
}
```
(If `senders` SELECT in this file uses an explicit column list rather than `*`, match that style.)

- [ ] **Step 4: Run** the test → passed. **Step 5: Commit**
```bash
git add server/src/repos/senders.ts server/test/abe.defaultSender.test.ts
git commit -m "feat(abe): getDefaultSender (is_default sender lookup)"
```

---

### Task 4: Eligibility filter (skip suppressed / unsubscribed / re-engaged)

**Files:**
- Create: `server/src/repos/agentEligible.ts`
- Test: `server/test/abe.eligible.repo.test.ts`

**Definition:** given a set of contact ids, return those that are still `subscribed`, NOT suppressed, AND (if `reengagedSince` is provided) have NO open/click event at/after `reengagedSince`. (When `reengagedSince` is null — touch 0 — only suppression/subscription filter applies.)

- [ ] **Step 1: Failing test** `server/test/abe.eligible.repo.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { findEligibleContacts } from '../src/repos/agentEligible.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function contact(tenantId: string, email: string, subscribed = true) {
  const r = await pool.query(
    `INSERT INTO contacts (tenant_id, email, subscribed) VALUES ($1,$2,$3) RETURNING id`,
    [tenantId, email, subscribed]);
  return r.rows[0].id as string;
}
async function senderId(tenantId: string) {
  const cfg = await pool.query(
    `INSERT INTO smtp_configs (tenant_id, name, host, port, secure, username, password_encrypted, from_domain)
     VALUES ($1,'c','h',25,false,'u','\\x00','x.io') RETURNING id`, [tenantId]);
  const s = await pool.query(
    `INSERT INTO senders (tenant_id, email, display_name, smtp_config_id, is_default)
     VALUES ($1,'from@x.io','X',$2,true) RETURNING id`, [tenantId, cfg.rows[0].id]);
  return s.rows[0].id as string;
}
async function openedAt(tenantId: string, sid: string, toAddr: string, daysAgo: number) {
  const e = await pool.query(
    `INSERT INTO emails (tenant_id, sender_id, to_addr, subject, body_html, status)
     VALUES ($1,$2,$3,'s','<p>b</p>','sent') RETURNING id`, [tenantId, sid, toAddr]);
  await pool.query(
    `INSERT INTO email_events (email_id, tenant_id, type, created_at)
     VALUES ($1,$2,'open', now() - make_interval(days => $3))`, [e.rows[0].id, tenantId, daysAgo]);
}

describe('findEligibleContacts', () => {
  it('drops suppressed, unsubscribed, and (since cutoff) re-engaged contacts', async () => {
    const t = await createTenant(pool);
    const sid = await senderId(t.id);
    const keep = await contact(t.id, 'keep@x.io');
    const unsub = await contact(t.id, 'unsub@x.io', false);
    const supp = await contact(t.id, 'supp@x.io');
    await pool.query(`INSERT INTO suppressions (tenant_id, address, reason) VALUES ($1,'supp@x.io','manual')`, [t.id]);
    const reeng = await contact(t.id, 'reeng@x.io');
    await openedAt(t.id, sid, 'reeng@x.io', 1); // opened yesterday

    const ids = [keep, unsub, supp, reeng];
    const cutoff = new Date(Date.now() - 3 * 24 * 3600 * 1000); // 3 days ago
    const eligible = await findEligibleContacts(pool, t.id, ids, cutoff);
    expect(eligible.map(c => c.email)).toEqual(['keep@x.io']);

    // With no cutoff, the re-engaged one is kept (only suppression/subscription filter).
    const noCut = await findEligibleContacts(pool, t.id, ids, null);
    expect(noCut.map(c => c.email).sort()).toEqual(['keep@x.io', 'reeng@x.io']);
  });
});
```

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement** `server/src/repos/agentEligible.ts`:
```ts
import type pg from 'pg';
import type { ContactRow } from './contacts.js';

/** From `contactIds`, the contacts still subscribed, not suppressed, and (if reengagedSince set) with
 *  no open/click at/after that time. Pass reengagedSince=null to apply only suppression/subscription. */
export async function findEligibleContacts(
  pool: pg.Pool,
  tenantId: string,
  contactIds: string[],
  reengagedSince: Date | null,
): Promise<ContactRow[]> {
  if (contactIds.length === 0) return [];
  const r = await pool.query<ContactRow>(
    `SELECT c.*
       FROM contacts c
      WHERE c.tenant_id = $1
        AND c.id = ANY($2::uuid[])
        AND c.subscribed = true
        AND NOT EXISTS (
              SELECT 1 FROM suppressions s
               WHERE s.tenant_id = c.tenant_id AND lower(s.address) = lower(c.email))
        AND ($3::timestamptz IS NULL OR NOT EXISTS (
              SELECT 1 FROM email_events ev
                JOIN emails e ON e.id = ev.email_id
               WHERE e.tenant_id = c.tenant_id
                 AND lower(e.to_addr) = lower(c.email)
                 AND ev.type IN ('open','click')
                 AND ev.created_at >= $3))
      ORDER BY c.created_at ASC`,
    [tenantId, contactIds, reengagedSince],
  );
  return r.rows;
}
```

- [ ] **Step 4: Run** → passed. **Step 5: Commit**
```bash
git add server/src/repos/agentEligible.ts server/test/abe.eligible.repo.test.ts
git commit -m "feat(abe): findEligibleContacts (skip suppressed/unsubscribed/re-engaged)"
```

---

### Task 5: `queuePlayTouch` — fan out one touch to eligible contacts

**Files:**
- Create: `server/src/agent/abe/execute.ts`
- Test: `server/test/abe.execute.queueTouch.test.ts`

**Behavior:** for play `p` and `touchIndex`, load the audience contact ids from `p.audience_snapshot.contact_ids`, filter via `findEligibleContacts` (reengagedSince = `p.executed_at` for touchIndex>0, else null), and for each eligible contact insert ONE queued email tagged `play_id=p.id`, `sender_id` = the default sender, `scheduled_for` = the touch's due time, with the touch's subject/body + an unsubscribe footer (mirror `marketing/campaignSend.ts`). Record an `agent_play_outcomes` row `(play_id, touch_index, sends = queuedCount)`. Returns `{ queued, skipped }`.

- [ ] **Step 1: Read `marketing/campaignSend.ts`** (scoped) for the exact unsubscribe-footer construction (`signUnsubToken` + `${baseUrl}/v1/unsubscribe/${token}` + footer HTML + the `listUnsubscribe` header value) and the `insertEmail` call shape. Mirror it.

- [ ] **Step 2: Failing test** `server/test/abe.execute.queueTouch.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { upsertGoal } from '../src/repos/agentGoals.js';
import { insertPlay } from '../src/repos/agentPlays.js';
import { getDefaultSender } from '../src/repos/senders.js';
import { queuePlayTouch } from '../src/agent/abe/execute.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function defSender(tenantId: string) {
  const cfg = await pool.query(
    `INSERT INTO smtp_configs (tenant_id, name, host, port, secure, username, password_encrypted, from_domain)
     VALUES ($1,'c','h',25,false,'u','\\x00','x.io') RETURNING id`, [tenantId]);
  await pool.query(
    `INSERT INTO senders (tenant_id, email, display_name, smtp_config_id, is_default)
     VALUES ($1,'from@x.io','X',$2,true)`, [tenantId, cfg.rows[0].id]);
  return (await getDefaultSender(pool, tenantId))!;
}
async function contact(tenantId: string, email: string) {
  const r = await pool.query(`INSERT INTO contacts (tenant_id, email) VALUES ($1,$2) RETURNING id`, [tenantId, email]);
  return r.rows[0].id as string;
}

describe('queuePlayTouch', () => {
  it('queues one email per eligible contact, tagged with play_id, and records an outcome row', async () => {
    const t = await createTenant(pool);
    const sender = await defSender(t.id);
    const c1 = await contact(t.id, 'a@x.io');
    const c2 = await contact(t.id, 'b@x.io');
    const g = await upsertGoal(pool, t.id, { enabled: true });
    const play = await insertPlay(pool, {
      tenantId: t.id, goalId: g.id, riskScore: 2,
      audienceSnapshot: { contact_ids: [c1, c2], size: 2 },
      touches: [{ index: 0, subject: 'Miss you', body_html: '<p>come back</p>', scheduled_offset_days: 0 }],
    });

    const res = await queuePlayTouch({ pool, baseUrl: 'http://localhost', play, touchIndex: 0, sender, reengagedSince: null });
    expect(res.queued).toBe(2);

    const emails = await pool.query(`SELECT play_id, status, body_html FROM emails WHERE tenant_id = $1`, [t.id]);
    expect(emails.rows).toHaveLength(2);
    expect(emails.rows.every(r => r.play_id === play.id)).toBe(true);
    expect(emails.rows.every(r => r.status === 'queued')).toBe(true);
    expect(emails.rows[0].body_html).toContain('unsubscribe'); // footer present

    const oc = await pool.query(`SELECT touch_index, sends FROM agent_play_outcomes WHERE play_id = $1`, [play.id]);
    expect(oc.rows[0]).toMatchObject({ touch_index: 0, sends: 2 });
  });
});
```

- [ ] **Step 3: Implement** `server/src/agent/abe/execute.ts`:
```ts
import type pg from 'pg';
import type { PlayRow } from '../../repos/agentPlays.js';
import type { Sender } from '../../repos/senders.js';
import { insertEmail } from '../../repos/emails.js';
import { findEligibleContacts } from '../../repos/agentEligible.js';
import { signUnsubToken } from '../../marketing/unsubscribe.js';

function unsubFooter(baseUrl: string, token: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const url = `${base}/v1/unsubscribe/${token}`;
  return `<hr/><p style="font-size:12px;color:#888">If you'd rather not hear from us, <a href="${url}">unsubscribe</a>.</p>`;
}

export async function queuePlayTouch(args: {
  pool: pg.Pool; baseUrl: string; play: PlayRow; touchIndex: number; sender: Sender; reengagedSince: Date | null;
}): Promise<{ queued: number; skipped: number }> {
  const { pool, baseUrl, play, touchIndex, sender, reengagedSince } = args;
  const touch = play.touches[touchIndex];
  if (!touch) throw new Error(`queuePlayTouch: no touch at index ${touchIndex}`);

  const ids = play.audience_snapshot.contact_ids;
  const eligible = await findEligibleContacts(pool, play.tenant_id, ids, reengagedSince);
  const scheduledFor = new Date(Date.now() + touch.scheduled_offset_days * 24 * 3600 * 1000);

  let queued = 0;
  for (const c of eligible) {
    const token = signUnsubToken(play.tenant_id, c.id, /* encKey */ (args as any).encKey ?? undefinedKey());
    // NOTE (implementer): signUnsubToken needs the enc key (Buffer). Thread `encKey: Buffer` through this
    // function's args instead of the placeholder above (see Step 4) and build the unsubscribe URL from it.
    const bodyHtml = `${touch.body_html}${unsubFooter(baseUrl, token)}`;
    await insertEmail(pool, {
      tenantId: play.tenant_id, senderId: sender.id, toAddr: c.email,
      subject: touch.subject, bodyHtml, status: 'queued', scheduledFor, playId: play.id,
    });
    queued += 1;
  }

  await pool.query(
    `INSERT INTO agent_play_outcomes (play_id, tenant_id, touch_index, sends) VALUES ($1,$2,$3,$4)`,
    [play.id, play.tenant_id, touchIndex, queued],
  );
  return { queued, skipped: ids.length - queued };
}
function undefinedKey(): never { throw new Error('encKey required'); }
```

- [ ] **Step 4: Correct the encKey threading.** The placeholder above is intentional — replace it: add `encKey: Buffer` to the `queuePlayTouch` args type, use it in `signUnsubToken(play.tenant_id, c.id, encKey)`, delete the `undefinedKey` helper and the NOTE. Update the test to pass `encKey: Buffer.alloc(32, 1)`. Re-confirm the test still expresses the same assertions (add `encKey` to the `queuePlayTouch({...})` call).

- [ ] **Step 5: Run** `cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.execute.queueTouch.test.ts --no-file-parallelism` → passed. Confirm `insertEmail`'s arg names match what Step 1 found (adjust the call if needed, e.g. `bodyHtml` vs `body_html`).

- [ ] **Step 6: Commit**
```bash
git add server/src/agent/abe/execute.ts server/test/abe.execute.queueTouch.test.ts
git commit -m "feat(abe): queuePlayTouch — fan out a touch to eligible contacts"
```

---

### Task 6: `startPlayExecution` — begin a play (queue touch 0)

**Files:**
- Modify: `server/src/agent/abe/execute.ts` (add `startPlayExecution`)
- Test: `server/test/abe.execute.start.test.ts`

**Behavior:** mark the play `executing`, set `executed_at = now()`, resolve the default sender (if none → throw `no_sender`), and queue touch 0 (`reengagedSince = null`). Returns `{ queued, skipped }`. Idempotency: only acts on a play whose status is `proposed`, `approved`, or `pending_approval`; throws if already executing/done.

- [ ] **Step 1: Failing test** `server/test/abe.execute.start.test.ts` — seed a tenant with a default sender, a goal, two contacts, and a `proposed` play (1 touch). Call `startPlayExecution`. Assert: play row status becomes `executing` and `executed_at` is set; 2 emails queued tagged with play_id; an outcome row for touch 0. Also assert that calling it with NO default sender throws an error whose message includes `no_sender`. (Mirror the seeding helpers from Task 5.)

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement** — add to `execute.ts`:
```ts
import { getDefaultSender } from '../../repos/senders.js';

export async function startPlayExecution(args: {
  pool: pg.Pool; encKey: Buffer; baseUrl: string; play: PlayRow;
}): Promise<{ queued: number; skipped: number }> {
  const { pool, encKey, baseUrl, play } = args;
  if (!['proposed', 'approved', 'pending_approval'].includes(play.status)) {
    throw new Error(`startPlayExecution: play ${play.id} not startable (status ${play.status})`);
  }
  const sender = await getDefaultSender(pool, play.tenant_id);
  if (!sender) throw new Error('no_sender');

  const upd = await pool.query(
    `UPDATE agent_plays SET status = 'executing', executed_at = now(), updated_at = now()
       WHERE id = $1 RETURNING *`, [play.id]);
  const executing = upd.rows[0] as PlayRow;

  return queuePlayTouch({ pool, encKey, baseUrl, play: executing, touchIndex: 0, sender, reengagedSince: null });
}
```

- [ ] **Step 4: Run → passed. Step 5: Commit**
```bash
git add server/src/agent/abe/execute.ts server/test/abe.execute.start.test.ts
git commit -m "feat(abe): startPlayExecution — mark executing + queue touch 0"
```

---

### Task 7: In-app approve / reject endpoints

**Files:**
- Modify: `server/src/routes/abe.ts`
- Test: `server/test/abe.approve.routes.test.ts`

**Endpoints (session, admin):**
- `POST /api/agent/plays/:id/approve` — play must be `proposed` or `pending_approval`; calls `startPlayExecution`; returns `{ play }` (now executing) + `{ queued }`.
- `POST /api/agent/plays/:id/reject` — body `{ reason?: string }`; sets status `rejected`, `rejection_reason`; returns `{ play }`.

- [ ] **Step 1: Failing test** `server/test/abe.approve.routes.test.ts` — build the app (no stub needed; sends are just queued, not dispatched), create an admin session (mirror `abe.routes.test.ts`/`agent.test.ts`), seed a default sender + a `proposed` play with audience of 1 contact. POST approve ⇒ 200, returned play status `executing`, `queued === 1`, and a queued email exists tagged play_id. Separately, POST reject with `{reason:'not now'}` on a fresh proposed play ⇒ 200, status `rejected`, rejection_reason persisted. Also assert approve by a non-admin role ⇒ 403 (if the helper can create a `tenant_user`).

- [ ] **Step 2: Run, confirm fail (404s).**

- [ ] **Step 3: Implement** — add to `registerAbeRoutes` in `routes/abe.ts`:
```ts
import { getPlay } from '../repos/agentPlays.js';
import { startPlayExecution } from '../agent/abe/execute.js';

app.post('/api/agent/plays/:id/approve', async (req, reply) => {
  try {
    const ctx = requireTenantCtx(req);
    if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') throw new AppError('forbidden', 403, 'Admin role required');
    const { id } = req.params as { id: string };
    const play = await getPlay(app.pool, ctx.tenantId, id);
    if (!play) throw new AppError('not_found', 404, 'Play not found');
    if (play.status !== 'proposed' && play.status !== 'pending_approval') {
      throw new AppError('conflict', 409, `Play not approvable (status ${play.status})`);
    }
    const { queued } = await startPlayExecution({ pool: app.pool, encKey: app.cfg.encKey, baseUrl: app.cfg.publicBaseUrl, play });
    const updated = await getPlay(app.pool, ctx.tenantId, id);
    return reply.send({ play: updated, queued });
  } catch (e) { sendError(reply, e); }
});

app.post('/api/agent/plays/:id/reject', async (req, reply) => {
  try {
    const ctx = requireTenantCtx(req);
    if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') throw new AppError('forbidden', 403, 'Admin role required');
    const { id } = req.params as { id: string };
    const { reason } = (req.body ?? {}) as { reason?: string };
    const play = await getPlay(app.pool, ctx.tenantId, id);
    if (!play) throw new AppError('not_found', 404, 'Play not found');
    const upd = await app.pool.query(
      `UPDATE agent_plays SET status = 'rejected', rejection_reason = $3, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 RETURNING *`, [ctx.tenantId, id, reason ?? null]);
    return reply.send({ play: upd.rows[0] });
  } catch (e) { sendError(reply, e); }
});
```

- [ ] **Step 4: Run → passed. Step 5: Commit**
```bash
git add server/src/routes/abe.ts server/test/abe.approve.routes.test.ts
git commit -m "feat(abe): in-app approve/reject endpoints (approve starts execution)"
```

---

### Task 8: Wire tiered auto-fire into the shift

**Files:**
- Modify: `server/src/agent/abe/shift.ts`
- Test: extend `server/test/abe.shift.test.ts`

**Behavior:** after `runAbeShift` inserts the proposed play, consult `requiresApproval(audienceSize, goal.auto_fire_max_audience)`:
- requires approval (default, cap 0) ⇒ set play `pending_approval`, return `{ status: 'pending_approval', playId, audienceSize }`.
- does NOT require approval (cap raised, small audience) ⇒ `startPlayExecution` immediately, return `{ status: 'executed', playId, audienceSize, queued }`.

This changes `ShiftResult`. Update the type and the cron counters (Task 9 expects `proposed`/`executed`/`pending_approval`).

- [ ] **Step 1: Update the test** — the existing "creates a proposed play" case currently expects `status === 'proposed'`. With auto-fire OFF by default it should now expect `status === 'pending_approval'`. Add a new case: with `autoFireMaxAudience: 100` and a default sender seeded + 2 dormant contacts, expect `status === 'executed'`, `queued === 2`, and the play row status `executing`. Keep the skip cases unchanged.

- [ ] **Step 2: Run, confirm the updated expectations fail against current code.**

- [ ] **Step 3: Implement** — change `shift.ts`:
```ts
import { requiresApproval } from './risk.js';
import { startPlayExecution } from './execute.js';

export type ShiftResult =
  | { status: 'executed'; playId: string; audienceSize: number; queued: number }
  | { status: 'pending_approval'; playId: string; audienceSize: number }
  | { status: 'skipped'; reason: 'no_goal' | 'goal_disabled' | 'no_openai_key' | 'no_dormant_contacts' };
```
After `insertPlay(...)`:
```ts
  const audienceSize = dormant.length;
  if (requiresApproval(audienceSize, goal.auto_fire_max_audience)) {
    await pool.query(`UPDATE agent_plays SET status = 'pending_approval', updated_at = now() WHERE id = $1`, [play.id]);
    return { status: 'pending_approval', playId: play.id, audienceSize };
  }
  // auto-fire
  const fresh = await getPlay(pool, tenantId, play.id);
  const { queued } = await startPlayExecution({ pool, encKey, baseUrl, play: fresh! });
  return { status: 'executed', playId: play.id, audienceSize, queued };
```
Thread `baseUrl` into `runAbeShift` args (add `baseUrl: string`) and import `getPlay`. NOTE: if auto-fire is on but there is no default sender, `startPlayExecution` throws `no_sender` — let it propagate (the cron's per-tenant catch records it; the in-app path surfaces it). Update `runAbeShift`'s callers (the cron in Plan A) to pass `baseUrl: app.cfg.publicBaseUrl` — that change is Task 9.

- [ ] **Step 4: Run** the shift test → passed (updated + new case). **Step 5: Commit**
```bash
git add server/src/agent/abe/shift.ts server/test/abe.shift.test.ts
git commit -m "feat(abe): tiered auto-fire in shift (pending_approval vs executed)"
```

---

### Task 9: `abe-touches` cron + update `abe-shift` caller

**Files:**
- Modify: `server/src/routes/cron.ts` (add `POST /v1/cron/abe-touches`; pass `baseUrl` to `runAbeShift` in the existing `abe-shift` route)
- Create: `server/src/agent/abe/touches.ts` (the per-play touch advancer)
- Test: `server/test/abe.touches.cron.test.ts`

**`advancePlayTouches` behavior:** for one `executing` play, compute the next touch index = (count of existing `agent_play_outcomes` rows for the play). If `nextIndex >= play.touches.length` ⇒ mark play `done`, return `{ done: true }`. If `now < play.executed_at + nextIndex * goal.touch_spacing_days` ⇒ not due, return `{ queued: 0, due: false }`. Otherwise `queuePlayTouch(nextIndex, reengagedSince = play.executed_at)`; if that was the last touch, mark `done`. Returns a small summary.

**Cron `POST /v1/cron/abe-touches`:** cron-secret protected; load all `executing` plays (add `listExecutingPlays(pool)` to `agentPlays.ts`); for each, load its goal (for `touch_spacing_days`) + default sender, call `advancePlayTouches` inside a per-tenant try/catch; return `{ ok, plays, touchesQueued, done, skipped }`.

- [ ] **Step 1:** add `listExecutingPlays(pool: pg.Pool): Promise<PlayRow[]>` to `repos/agentPlays.ts` (`SELECT * FROM agent_plays WHERE status = 'executing' ORDER BY executed_at ASC`) with a tiny repo test (or fold into the cron test).

- [ ] **Step 2: Failing test** `server/test/abe.touches.cron.test.ts`:
  - Build app (`agentLlmFactory` not needed). Seed: tenant, default sender, goal with `touch_spacing_days: 0` (so touch 1 is immediately due) and `enabled: true`, 2 contacts, and a play already `executing` with `executed_at = now()`, two touches, and ONE existing outcome row for touch_index 0 (simulating touch 0 already queued).
  - POST `/v1/cron/abe-touches` without secret ⇒ 401.
  - POST with `x-cron-secret` ⇒ 200; `touchesQueued >= 1`; a new outcome row for touch_index 1 exists; emails for touch 1 are queued tagged play_id; after the last touch the play status becomes `done`.
  - Add an assertion that a contact who has an `open` event dated after `executed_at` is NOT queued for touch 1 (auto-skip): seed a 3rd contact with a post-executed_at open and assert only 2 emails for touch 1.

- [ ] **Step 3: Run, confirm fail.**

- [ ] **Step 4: Implement** `server/src/agent/abe/touches.ts`:
```ts
import type pg from 'pg';
import type { PlayRow } from '../../repos/agentPlays.js';
import type { Sender } from '../../repos/senders.js';
import { queuePlayTouch } from './execute.js';

export async function advancePlayTouches(args: {
  pool: pg.Pool; encKey: Buffer; baseUrl: string; play: PlayRow; touchSpacingDays: number; sender: Sender;
}): Promise<{ done: boolean; due: boolean; queued: number; touchIndex: number | null }> {
  const { pool, encKey, baseUrl, play, touchSpacingDays, sender } = args;
  const cnt = await pool.query<{ n: string }>(
    `SELECT count(*)::int AS n FROM agent_play_outcomes WHERE play_id = $1`, [play.id]);
  const nextIndex = Number(cnt.rows[0].n);

  if (nextIndex >= play.touches.length) {
    await pool.query(`UPDATE agent_plays SET status = 'done', updated_at = now() WHERE id = $1`, [play.id]);
    return { done: true, due: false, queued: 0, touchIndex: null };
  }
  const executedAt = play.executed_at ? new Date(play.executed_at).getTime() : 0;
  const dueAt = executedAt + nextIndex * touchSpacingDays * 24 * 3600 * 1000;
  if (Date.now() < dueAt) return { done: false, due: false, queued: 0, touchIndex: nextIndex };

  const reengagedSince = play.executed_at ? new Date(play.executed_at) : null;
  const { queued } = await queuePlayTouch({ pool, encKey, baseUrl, play, touchIndex: nextIndex, sender, reengagedSince });

  let done = false;
  if (nextIndex + 1 >= play.touches.length) {
    await pool.query(`UPDATE agent_plays SET status = 'done', updated_at = now() WHERE id = $1`, [play.id]);
    done = true;
  }
  return { done, due: true, queued, touchIndex: nextIndex };
}
```
(NOTE on timing: `Date.now()`/`new Date()` are normal here — this is server runtime, not a workflow script.)

- [ ] **Step 5: Add the cron route** to `cron.ts` (mirror `abe-shift`'s auth + per-tenant try/catch):
```ts
import { listExecutingPlays } from '../repos/agentPlays.js';
import { getGoal } from '../repos/agentGoals.js';
import { getDefaultSender } from '../repos/senders.js';
import { advancePlayTouches } from '../agent/abe/touches.js';

app.post('/v1/cron/abe-touches', async (req, reply) => {
  requireCronAuth(req, app.cfg.cronSecret);
  const plays = await listExecutingPlays(app.pool);
  let touchesQueued = 0, done = 0;
  const skipped: Array<{ playId: string; reason: string }> = [];
  for (const p of plays) {
    try {
      const goal = await getGoal(app.pool, p.tenant_id);
      const sender = await getDefaultSender(app.pool, p.tenant_id);
      if (!goal || !sender) { skipped.push({ playId: p.id, reason: !goal ? 'no_goal' : 'no_sender' }); continue; }
      const r = await advancePlayTouches({
        pool: app.pool, encKey: app.cfg.encKey, baseUrl: app.cfg.publicBaseUrl,
        play: p, touchSpacingDays: goal.touch_spacing_days, sender,
      });
      touchesQueued += r.queued;
      if (r.done) done += 1;
    } catch (err) { skipped.push({ playId: p.id, reason: err instanceof Error ? err.message : String(err) }); }
  }
  return reply.send({ ok: true, plays: plays.length, touchesQueued, done, skipped });
});
```
Also in the existing `abe-shift` route, update the `runAbeShift({...})` call to pass `baseUrl: app.cfg.publicBaseUrl` (Task 8 added that required arg), and adjust its counters to the new `ShiftResult` (`proposed` → count `pending_approval` and `executed` separately, e.g. return `{ ok, goals, executed, pendingApproval, skipped }`).

- [ ] **Step 6: Run** `cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/abe.touches.cron.test.ts test/abe.cron.test.ts --no-file-parallelism`. Fix the `abe-shift` cron test if its response-shape assertions changed (update to the new counters). → all passed.

- [ ] **Step 7: Run the FULL suite** `cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm test -- --no-file-parallelism` → all green; no previously-passing test broken.

- [ ] **Step 8: Commit**
```bash
git add server/src/routes/cron.ts server/src/agent/abe/touches.ts server/src/repos/agentPlays.ts server/test/abe.touches.cron.test.ts server/test/abe.cron.test.ts
git commit -m "feat(abe): abe-touches cron — advance plays through touches with auto-skip"
```

---

## Production / cron wiring (after the suite is green)

- [ ] Register the `abe-touches` cron in the scheduler (alongside `process-queue`/`retry-failed`/`abe-shift`), daily, with `CRON_SECRET`. (Touch emails are queued; the existing `process-queue` cron dispatches them when `scheduled_for` is due.)
- [ ] Prod Neon migration: run the B1 migration (`<N+1>_abe_act.cjs`) against the prod branch before deploy (also the still-pending Plan A migration `1700000000021_abe.cjs`).

---

## Self-Review (completed during planning)

**1. Spec coverage (B1 slice):**
- Tiered ACT (auto-fire vs. escalate) → Task 8 (auto-fire OFF by default via cap 0 → `pending_approval`). ✓
- Execute = send the sequence via existing pipeline, tagged for measurement → Tasks 1,2,5,6. ✓
- Auto-skip re-engaged mid-sequence → Task 4 (`reengagedSince`) + Task 9 (`advancePlayTouches` passes `executed_at`). ✓
- In-app approval (the B1 stand-in for email approval) → Task 7. ✓
- Sender = tenant default; no-sender handled → Tasks 3,6. ✓
- Compliance (unsub link/footer on every touch) → Task 5 (mirrors campaignSend). ✓
- *Deferred by design:* approval-over-email (B2); REPORT/LEARN incl. outcome aggregation queries (B3 — B1 only WRITES `agent_play_outcomes.sends`). ✓

**2. Placeholder scan:** The one intentional placeholder (the `encKey` in `queuePlayTouch` Step 3) is explicitly corrected in Step 4 with instructions — not a silent gap. All other steps carry complete code.

**3. Type consistency:** `PlayRow`/`Touch`/`AudienceSnapshot` reused from Plan A unchanged. New `ShiftResult` (Task 8) statuses (`executed`/`pending_approval`/`skipped`) match the cron counters (Task 9). `queuePlayTouch` args (incl. `encKey: Buffer`) match `startPlayExecution` and `advancePlayTouches` call sites. `findEligibleContacts` returns `ContactRow`.

**Known verification points for the implementer** (named, not guessed): exact `insertEmail` arg property names + column list (Task 2/5 Step 1); `marketing/campaignSend.ts` footer + `listUnsubscribe` construction to mirror (Task 5 Step 1); the `senders`/`smtp_configs` insert columns in test seeds (Tasks 2–5); the `abe-shift` cron test's response-shape assertions after the counter change (Task 9 Step 6).
