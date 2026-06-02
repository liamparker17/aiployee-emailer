# Abe — Client Line Intelligence & Advisory (report-to-ABSA) — Design (v1)

**Date:** 2026-06-02
**Status:** Approved design — ready for implementation planning.
**Builds on:**
- `2026-06-01-agentic-employee-reengage-design.md` — Abe's loop, shift/cron, approval gate, activity feed.
- `2026-06-01-abe-chat-design.md` — the "Talk to Abe" chat surface and the tool-provider pattern (`runner.ts` + Abe tool provider).
- `docs/agent-jobix-integration.md` + migration `1700000000008_agent.cjs` — inbound call summaries land as `agent_messages` (`role='inbound'`, `source='jobix'`) inside `agent_threads`.

---

## The thesis (why this exists)

Abe today is a one-job **outbound** employee: he finds dormant email contacts and runs approval-gated win-back plays. But the live use case is the near-opposite shape. First Assist runs a phone line; **people call in**, those calls become summaries that land in the email system, and a human operator must turn "what people phoned about" into **clear, timely, trustworthy updates to ABSA (the client)**.

That is inbound-intelligence reporting, not outbound campaigning. This spec gives Abe a **second job — "Client Line Intelligence & Advisory"** — built on the loop he already runs, pointed inbound. The recipient changes from "your line manager" to "the client (ABSA)"; everything else (perceive → decide → approval-gate → report) reuses what already works.

**Abe is a business analyst and a PR advisor in one.** He does not stop at *what is wrong* — every notable finding and every escalated case carries *what to do about it and how to say it*. Two halves, always paired:
- **DIAGNOSE (analyst):** what's happening, how big, and a clearly-labelled **root-cause hypothesis** (correlating timing/themes/events — stated as a hypothesis, never as fact).
- **PRESCRIBE (advisor + PR):** **recommended actions** case by case (what to do, who owns it, how urgent), plus **draft communications** — customer-facing holding/response copy, an internal/ABSA escalation note, and talking points for anything reputational.

So a "case" is not *"here's a bad call, forwarded"* — it is *"here's the case, here's exactly what I'd do, and here's drafted wording you can approve and send."* The approval gate is unchanged: Abe proposes the diagnosis **and** the fix **and** the wording; the operator approves or edits before anything leaves.

### The operator problems this must solve
1. **Aggregation grind** — raw calls are scattered; turning them into "here's what people phoned about" is manual.
2. **Theme extraction** — pulling categories out of messy free-text call summaries.
3. **Signal over noise** — ABSA wants spikes and emerging issues, not a data dump.
4. **Cadence discipline** — a reliable daily/weekly update even when the operator is slammed.
5. **Client-appropriate voice** — it goes to the *client*; tone, format and accuracy matter.
6. **Urgent escalation** — a fraud surge or outage flood must reach ABSA *now*, not in the next digest.
7. **Traceability** — provable record of "we flagged X on date Y."
8. **Knowing what to *do* (and how to phrase it)** — spotting the problem is only half the job; the operator must also recommend a fix and write the client/customer-facing wording. This is the analyst-plus-PR work Abe takes on.

---

## Locked decisions (2026-06-02)

1. **Approach A — Abe's second job.** Reuse the shift/cron, approval gate, activity feed, and "Talk to Abe" chat. New surface is narrow: tools that read call summaries, a tag-and-detect step, and a `line_reports` draft artifact.
2. **Draft-everything, human-approves.** Nothing reaches ABSA without an explicit in-app approval. No auto-send, no risk-tiering in v1. The shift and chat can *only* create `pending_approval` reports; only the approve endpoint can email ABSA. This is the structural send-gate.
3. **All four deliverables ship** as `report_type`s on one job: `digest`, `alert`, `answer`, `case`.
4. **Tag once at ingest.** Each inbound call summary is classified exactly once into a category + severity + emerging flag, persisted to `line_call_tags`. This single store powers stable trends, instant ad-hoc answers, spike math, and case flagging — without re-reading raw calls each time.
5. **Cadence: both daily + weekly.** A short daily pulse plus a richer weekly rollup. Spike alerts and case escalations fire any time, independent of cadence.
6. **Fixed, editable taxonomy** (ABSA-banking starter set) — stable categories give trustworthy week-over-week trends; genuinely new themes surface via the `Other / Emerging` bucket and the `is_emerging` flag.
7. **Spike rule: balanced** — flag a category when it is up **≥50%** vs its trailing baseline **and** has **≥5 calls** in the window. Tunable per tenant.
8. **One tenant = one client (ABSA) in v1.** Multi-client per tenant is deferred; the schema is per-tenant so a second client is a future tenant or a future `client_id` column.
9. **Diagnose + prescribe, always paired.** Every `digest`, `alert`, and `case` carries an `advisory` payload: `diagnosis`, `root_cause_hypothesis`, `recommended_actions[]` (action + owner + urgency), and `draft_comms` (`customer_message`, `internal_note`, `talking_points`). This is the analyst+PR core, not an optional extra — the compose step always produces it. Hypotheses are labelled as hypotheses; draft comms are *drafts* that gate before sending.

---

## The loop, concretely

Calls → Jobix → `agent_messages` (`role='inbound'`) — Abe's reading material.

### PERCEIVE — tag new calls (idempotent)
On each shift, select inbound `agent_messages` created since the last tag run that have no `line_call_tags` row. Classify each (bounded LLM batch) into:
- `category` — one of the tenant's taxonomy entries (LLM must pick from the fixed list; unknowns → `Other / Emerging` with `is_emerging=true`).
- `severity` — `low` | `med` | `high` (high = vulnerable customer, regulatory/complaint needing client action).
- `is_emerging` — true when the summary doesn't fit an existing category cleanly.

Write one `line_call_tags` row per message (unique on `message_id`, so re-runs are no-ops). Call summaries are **untrusted data**: the classifier prompt fences them as data, never instructions.

### DECIDE — aggregate + detect
- **Aggregate** the period from `line_call_tags` (counts per category, total, severity mix).
- **Spike detection:** for each category compare its window count to the trailing-baseline average (`baseline_periods`, default 4 same-length periods). Flag when `count ≥ spike_min_count` (default 5) **and** `count ≥ baseline_avg × (1 + spike_pct/100)` (default 50%).
- **Movement:** per-category delta vs the immediately prior period (for digest trend lines).

### COMPOSE — draft the deliverable, diagnosis **and** advisory (in brand voice)
Produce a `line_reports` row (`status='pending_approval'`) for each. Every row carries both the **diagnosis** (subject/body + metrics) and the **`advisory`** payload (the analyst+PR "how to fix it"):
- **digest** (on cadence) — total calls, top reasons by category, movement vs last period, emerging themes, notable cases; advisory = the top 1–3 things ABSA should act on this period + how to communicate them.
- **alert** (when a spike is detected) — heads-up naming the category + magnitude; advisory = root-cause hypothesis, recommended actions, and a draft customer/internal holding message.
- **case** (per new `severity='high'` call) — the call context; advisory = recommended handling (owner + urgency) and a drafted customer-facing response + internal escalation note.
- **answer** (ad-hoc, via chat) — composed on demand; advisory included when the question implies "what should we do?"

**The `advisory` payload (jsonb on every report):**
```
{ "diagnosis": "...",                          // plain-language what & how big
  "root_cause_hypothesis": "... (hypothesis)", // labelled as a hypothesis, may be null
  "recommended_actions": [ { "action": "...", "owner": "...", "urgency": "low|med|high" } ],
  "draft_comms": { "customer_message": "...", "internal_note": "...", "talking_points": ["..."] } }
```
The compose prompt fences all call content as untrusted **data**, and instructs Abe to (a) never assert a cause as fact, (b) keep recommended actions concrete and owned, and (c) write `draft_comms` in client-appropriate, brand-voiced language.

Each report also records `metrics` (jsonb) and `source_message_ids` for traceability.

### GATE — operator approves
Drafts surface in the **"Pending for ABSA"** queue (admin-only). Operator can **Edit / Approve / Reject**. Approve → send. Reject → `archived` with a reason.

### SEND + REPORT
Approve → send via the existing send pipeline to `recipients`; stamp `sent_at` + `email_id`; write a first-person entry to Abe's activity feed. The `line_reports` rows (with timestamps + `source_message_ids`) are the traceability record.

---

## Data model (3 new tables — all `tenant_id` FK `ON DELETE CASCADE`)

### `line_report_configs` (1 row per tenant)
- `enabled` boolean (default false)
- `daily_digest` boolean (default true), `weekly_rollup` boolean (default true)
- `weekly_send_day` int (0–6, default Monday), `send_time` time (tenant-local, default 08:00)
- `recipients` text[] — ABSA destination addresses, each validated as email
- `from_sender` text — must be a verified sending domain (reuse Abe's default-sender resolution)
- `taxonomy` jsonb — ordered list of category names (seeded with the ABSA starter set below)
- `spike_pct` int (default 50), `spike_min_count` int (default 5), `baseline_periods` int (default 4)
- `brand_voice` text — appended to the compose prompt (client-appropriate tone)
- `created_at`, `updated_at`

**Seed taxonomy:** `Card disputes / fraud`, `Online & app banking`, `Debit orders`, `Accounts & balances`, `Loans & credit`, `Fees & charges`, `Complaints`, `Other / Emerging`.

### `line_call_tags` (1 row per inbound message; idempotent)
- `id` uuid pk, `tenant_id` uuid, `message_id` uuid FK `agent_messages(id)` ON DELETE CASCADE
- `category` text, `severity` text check in (`low`,`med`,`high`), `is_emerging` boolean
- `created_at` timestamptz
- **Unique** on `(message_id)` — guarantees tag-once. Index on `(tenant_id, created_at)` and `(tenant_id, category)`.

### `line_reports` (the drafts / artifacts)
- `id` uuid pk, `tenant_id` uuid
- `report_type` text check in (`digest`,`alert`,`answer`,`case`)
- `period_start`, `period_end` timestamptz
- `status` text check in (`pending_approval`,`approved`,`sent`,`rejected`,`archived`), default `pending_approval`
- `subject` text, `body` text — the diagnosis written for ABSA; the composer weaves the advisory's recommended actions + talking points into the body so the approved email is self-contained.
- `metrics` jsonb — per-category counts + deltas + totals (and spike detail for alerts)
- `advisory` jsonb — the analyst+PR payload (`diagnosis`, `root_cause_hypothesis`, `recommended_actions[]`, `draft_comms`) rendered as editable fields in the UI. Default `{}`.
- `source_message_ids` jsonb — the `agent_messages` ids behind this report (traceability)
- `approved_by` uuid FK `users(id)` ON DELETE SET NULL, `approved_at` timestamptz
- `sent_at` timestamptz, `email_id` uuid (link to the sent `emails` row), `reject_reason` text
- `created_at` timestamptz. Index on `(tenant_id, status, created_at)`.

---

## "Talk to Abe" chat — new tools

Composed into the existing Abe tool provider (so they ride the existing `runner.ts` loop + approval safety):

**Read (always available):**
- `top_call_reasons(window)` → ranked categories with counts + deltas.
- `query_calls(window, category?)` → counts/examples from `line_call_tags` (+ summaries on request).
- `list_reports(status?)` → recent reports with type/status/period.
- `get_report(id?)` → a report's subject/body/metrics/sources (latest if no id).
- `get_report_settings` → current `line_report_configs`.

**Safe writes (execute, then confirm):**
- `draft_report(type, window)` → composes a report, persists as `pending_approval` ("I've queued it for your sign-off"). This is how "draft the ABSA weekly" works in chat.
- `update_report_settings(...)` → `upsert` of `line_report_configs`, **clamped to server bounds** (spike_pct 0–500, spike_min_count ≥1, baseline_periods 1–12; recipients validated; cadence flags boolean).

**Gated:** none. There is intentionally **no `send` tool.** Ad-hoc Q&A is the model answering via `query_calls`; if it warrants sending, it routes through `draft_report` → approval.

---

## Endpoints

- `GET /api/agent/line-reports?status=` (session, admin) → list reports.
- `GET /api/agent/line-reports/:id` (session, admin) → one report + sources.
- `POST /api/agent/line-reports/:id/approve` (session, admin) → send to `recipients`, stamp `sent_at`/`email_id`, feed entry. **The only path that emails ABSA.**
- `POST /api/agent/line-reports/:id/reject` (session, admin) → `archived` + reason.
- `PATCH /api/agent/line-reports/:id` (session, admin) → edit subject/body before approving.
- `GET`/`PUT /api/agent/line-report-settings` (session, admin) → read/update config.
- All gated by the existing `requireAdmin` check.

---

## UI — "Line Reporting" job card (Abe's home)

A second job card alongside re-engage:
- **Readiness:** recipients set? sending domain verified? calls flowing (any inbound in last N days)?
- **"What's coming in" snapshot:** today's call volume, top reasons, any active spike.
- **Pending for ABSA queue:** each card shows the **diagnosis** (subject + body + metrics) *and* the **advisory** — recommended actions (with owner/urgency), root-cause hypothesis, and the draft comms (customer message / internal note / talking points) — all editable, plus **the source calls** (traceability), with **Edit / Approve / Reject**. Approving sends the composed body (diagnosis + woven-in actions/talking points) to ABSA.
- **Sent log:** recent sent reports with timestamps (the audit trail ABSA can be pointed to).
- **Settings panel:** cadence (daily/weekly + day/time), recipients, taxonomy editor, spike thresholds, brand voice.

The "Talk to Abe" panel already exists and gains the new tools. Admin-only; verified by `cd web && npm run build`.

---

## Safety & compliance

- **Untrusted data:** call summaries and tool outputs are fenced as data, never instructions (Abe's existing posture).
- **Structural send-gate:** shift + chat can only create `pending_approval` reports; only `POST …/approve` sends. Provable by test.
- **Bounded writes:** `update_report_settings` clamps to the same bounds the forms use; recipients validated; sender must be verified.
- **Bounded LLM:** tagging runs in capped batches; reuse `max_tool_iterations`; per-compose output-token cap.
- **Audit:** every tool call → `agent_audit`; every report carries created/approved/sent timestamps + `source_message_ids`. This *is* deliverable #7.
- **POPIA:** call summaries may carry customer PII. Data stays tenant-scoped; digests aggregate; case escalations include only what ABSA needs to act. No raw PII leaves the tenant except inside an operator-approved report.

---

## Testing

**Backend (Vitest + stub LLM, serial against the Neon test branch):**
- Tagging: inbound messages get exactly one `line_call_tags` row; re-running the shift adds none (idempotent); unknown → `Other / Emerging` + `is_emerging`.
- Spike: a category seeded above threshold creates an `alert`; below threshold does not.
- Digest: a cadence run aggregates tags into a `digest` with correct per-category counts + deltas.
- Case: a `severity='high'` inbound creates a `case` report.
- **Safety test (the structural guarantee):** a stub that "tries to send to ABSA" through chat/shift results in at most a `pending_approval` report and **zero `emails` rows with status sent** — proving only approval sends.
- Approve endpoint: sends to configured recipients, stamps `sent_at`/`email_id`, moves status to `sent`.
- Admin gate: non-admin → 403.

**Frontend:** `cd web && npm run build`.

---

## Out of scope (v1)

Auto-send / risk-tiering; free-text replies *from* ABSA (inbound parsing); charts/visualizations (text + simple tables first); multi-client per tenant; SLA / handle-time metrics unless the call summaries carry timing data (note the dependency — if they do, it's a fast-follow `metrics` addition).

**Known v1 gap (fast-follow):** the advisory fields (`recommended_actions`, `draft_comms`, etc.) are editable via the `PATCH` endpoint and the client method, but the Pending-for-ABSA panel currently only exposes inline editing of `subject`/`body`. The advisory is woven into the emailed body (so it's still correctable there); a structured advisory editor in the UI is a fast-follow.

## Resolved during the build pass

- **Inbound call-summary shape:** the tagger reads `agent_messages.content` as free text (fenced as untrusted data); no structured-`context` dependency.
- **One digest composer, parameterized by period:** `composeDigest(periodLabel, start, end)` serves both daily and weekly.
- **Tenant-local send time:** the `/v1/cron/line-report` job runs **hourly** — tagging, spike alerts, and high-severity case escalations fire every hour (fast escalation), while digests are emitted only when `now.getUTCHours() === send_hour_utc` (and, for weekly, the configured weekday). `send_hour_utc` is the tenant's chosen UTC hour; per-tenant local-timezone offsets remain a future enhancement.
