# Abe — Agentic Employee (Re-engage Dormant Contacts) — Design (v1)

**Date:** 2026-06-01
**Status:** Draft for review — first vertical slice of the "agentic emailer" vision.
**Builds on:** `2026-05-29-agentic-ai-responses-design.md` (the reactive, approval-gated
Jobix responder — Phases 1–5 shipped). This spec turns that reactive responder into a
**proactive, goal-owning employee** for one objective, end to end.

---

## The thesis (why this exists)

Brevo/Mailchimp/Klaviyo are **cockpits**: a thousand levers, and the labor *and the
expertise* to pull them is 100% on the user. They're great if you're a skilled marketer
with time — most buyers are neither.

**Aiployee sells the job getting done, not the tool to do it.** You don't operate an
employee, you delegate to one. The product name is the promise: an **AI employee** who
*owns an outcome*, runs the work while you're away, gets smarter about your list over
time, and reports to a manager — you just steer.

The agent has a name: **Abe** (Aiployee Business Emailer). He sends from a real address,
signs his messages, and reports to a configurable line manager over email — like a remote
hire. The name is deliberate: it converts "the tool did X" into "Abe did X," which is the
entire UX shift.

### How Abe beats Brevo (the wedges this slice must prove)
1. **Kills the blank page** — Abe proposes a concrete play; the user never faces an empty editor.
2. **Always on shift** — Abe acts on a schedule while the user is away, and reports back.
3. **Compounds** — Abe records what worked for *this* list and surfaces it next time.

These are not three features. They are three moments of one loop (below).

---

## The Employee Loop (the single architecture)

```
        ┌──────────────────────────────────────────────┐
        │                                                │
   PERCEIVE ──▶ DECIDE ──▶ ACT (tiered) ──▶ REPORT ──▶ LEARN
   (scan        (plan a    (auto-fire        (teammate  (record
    contacts,    re-engage  low-risk;         update +   outcomes
    engagement,  play to    escalate          approval   for THIS
    prior        the goal,  high-risk to      email)     list)
    outcomes)    risk-score) line manager)                 │
        ▲                                                  │
        └──────────────────────────────────────────────────┘
```

The three wedges map onto loop moments: **kill-the-blank-page** = the loop's first run
(PERCEIVE→DECIDE→REPORT), **always-on** = the loop turning on its schedule,
**compounds** = LEARN writing back into PERCEIVE.

---

## Scope of this slice

**One job, fully autonomous: "Re-engage dormant contacts."** Abe runs the complete loop
for this single objective, with a configurable line manager approving over email.

**In scope:** the full loop for re-engagement; tiered (risk-scored) autonomy; line-manager
approval over email via signed buttons; a teammate-style activity feed; light LEARN
(record + surface outcomes).

**Out of scope (this slice):** other goal types; multi-channel; product-usage/login
signals for dormancy (email-engagement only); full natural-language inbound-email
*parsing* of manager replies (logged now, understood later); reinforcement learning.

---

## Locked decisions (2026-06-01)

1. **Vertical slice first** — entire loop for ONE goal (re-engage dormant) before widening
   to other goals. A thin-but-complete loop beats a wide-but-dead one.
2. **Tiered-by-risk autonomy, configurable thresholds** — low-risk auto-fires; high-risk
   escalates. The threshold (primarily audience size) is tenant-configurable.
3. **Line-manager approval = hybrid (option C).** HMAC-signed, single-use, expiring
   action buttons carry the *decision* (secure, no inbound parsing, reuses the unsubscribe
   link machinery). Email comes from a real monitored reply address so the manager can
   also type feedback; **free-text reply understanding is a fast-follow, not this slice.**
4. **"Dormant" = email-engagement only** — no opens/clicks in N days (default 60,
   configurable), minus unsubscribed/suppressed. Product-usage signals deferred.
5. **A "play" is a sequence of up to 3 touches**, approved once as a plan. The loop
   auto-skips anyone who re-engages mid-sequence (outcome-reactivity).
6. **The agent is named Abe** and is presented as a team member throughout the UX and
   in every email he sends.

---

## The loop, concretely

### PERCEIVE — scheduled shift
- Runs on the existing cron on the goal's configured cadence (default: daily).
- Builds the dormant cohort: contacts with no recorded open/click event in `dormant_window_days`,
  excluding unsubscribed/suppressed and anyone in an active re-engage play.
- Loads outcomes of recently completed plays (for LEARN feedback into DECIDE).

### DECIDE — plan a play
- Abe (existing OpenAI agent runner) drafts a re-engagement **play**: the cohort, up to 3
  message touches with copy + subject lines, and per-touch timing.
- Abe computes a **risk score** — primarily `audience_size` vs. `auto_fire_max_audience`,
  with hooks for future factors (new segment, unusual send volume).
- Inbound/contact data is treated as **data, not instructions** (existing safety posture).

### ACT — tiered
- `risk ≤ threshold` → **auto-fire**: the play executes via the existing send pipeline
  (queued sends honoring existing per-day rate limits).
- `risk > threshold` → **escalate**: status `pending_approval`; Abe emails the line manager.
- On manager **Approve** → execute. **Reject** → archive play, log reason. **Edit** → opens
  a hosted page to adjust copy/audience, then approve.

### REPORT — teammate update
- Every meaningful step writes a first-person entry to the **activity feed** ("Abe here —
  I found 1,240 dormant contacts and want to run a 3-touch win-back. Here's why…").
- The same content is the body of the approval email to the manager.
- A post-send report records what went out and to whom.

### LEARN — light for v1
- Per-play outcome record: sends, opens, clicks, reactivations (a dormant contact who
  opened/clicked within an attribution window).
- Surfaced in the next shift's PERCEIVE context and shown in the feed ("Last win-back
  reactivated 11% — better than the 6% before it").

---

## Line-manager approval (mechanic detail)

- **Config:** tenant sets `line_manager_email` (verified via a confirmation click at config
  time) and the risk thresholds.
- **Approval email** (from Abe, from a real monitored reply address): the play summary,
  audience size, drafts, and `[Approve] [Reject] [View & Edit]` buttons.
- **Buttons** are HMAC-signed URLs (same signer as unsubscribe): payload `{play_id,
  decision, tenant_id, exp}`, **single-use** (consumed on first valid hit), **expiring**
  (default 7 days). Verified server-side before the decision is recorded.
- **Reply channel:** the From/Reply-To is a real monitored address; manager replies are
  captured and logged against the play for context. Understanding/acting on free-text
  replies is the fast-follow.

---

## Data model (new tables; per-tenant, `tenant_id` FK ON DELETE CASCADE)

- **`agent_goals`** — `id`, `tenant_id`, `kind` (`reengage_dormant`), `enabled`,
  `schedule` (cron expr / cadence), `params jsonb` (`dormant_window_days`,
  `auto_fire_max_audience`, `max_touches`, `touch_spacing_days`), `line_manager_email`,
  `line_manager_verified_at`, timestamps.
- **`agent_plays`** — `id`, `tenant_id`, `goal_id`, `status`
  (`proposed`|`pending_approval`|`approved`|`rejected`|`executing`|`done`|`archived`),
  `risk_score`, `audience_snapshot jsonb` (contact ids + size at decision time),
  `touches jsonb` (ordered drafts: subject, body, scheduled_for), `rejection_reason`,
  timestamps.
- **`agent_approvals`** — `id`, `play_id`, `tenant_id`, `token_hash`, `manager_email`,
  `channel` (`button`|`reply`), `decision` (`approve`|`reject`|`edit`|null),
  `decided_at`, `expires_at`, `consumed_at`.
- **`agent_play_outcomes`** — `id`, `play_id`, `tenant_id`, `touch_index`, `sends`,
  `opens`, `clicks`, `reactivations`, `window_closed_at`, timestamps.

**Reuses:** `contacts`, segments, the send/queue pipeline, open/click tracking,
`agent_audit` (every tool call + action), HMAC link signer, `crypto/enc.ts`, cron.

---

## Endpoints

- **Cron shift handler** — protected by `CRON_SECRET`; iterates enabled `agent_goals`,
  runs PERCEIVE→DECIDE→ACT per tenant.
- `GET /api/agent/goals`, `PUT /api/agent/goals/:id` (session, admin) — config.
- `POST /api/agent/goals/:id/verify-manager` + email confirm link — verify line manager.
- `GET /api/agent/plays`, `GET /api/agent/plays/:id` (session) — feed + play detail.
- `POST /api/agent/plays/:id/reply` (session) — user steers via the feed.
- **Public, HMAC-verified** (no session — manager may not have an account):
  `GET /agent/approve/:token` resolving to approve / reject / edit views. Mirrors the
  existing public unsubscribe route.

---

## UI — the "Employee" surface (extends the existing "AI" tab)

- **Config panel:** enable goal, dormant window, auto-fire threshold, max touches/spacing,
  **line-manager email** (with verify), cadence.
- **Activity feed:** reverse-chronological, first-person Abe entries (thinking / proposed /
  acted / reported / learned), with pending-approval plays showing Approve/Edit/Reject
  inline *and* noting "also emailed to <manager>". A reply box lets the user steer Abe
  conversationally. This is a **colleague thread, not a dashboard.**

---

## Safety (reuse + extend)

- Existing posture carries over: contact/message content is **data, never instructions**;
  hardened system prompt; per-run token/iteration caps; full `agent_audit` trail.
- New: approval tokens **single-use + expiring + HMAC-signed**; line-manager email
  **verified** before it can approve; **tiered thresholds** are the hard autonomy boundary;
  existing **per-day send rate limits** protect sender reputation; auto-fire audience is
  hard-capped regardless of model output.
- Secrets (OpenAI key, etc.) stay in AES-GCM `crypto/enc.ts` (`EMAILER_ENC_KEY`).

---

## Infra / dependencies

No new infra. Reuses OpenAI SDK, existing cron, existing send pipeline + tracking, Neon,
HMAC signer. A single Abe run fits Vercel Fluid Compute's 300s window; large cohort sends
already queue through the existing pipeline.

---

## Open questions for the build pass

- Reactivation attribution window length (e.g. 14 days after a touch)?
- Default copy/voice guidance for Abe's drafts — tenant-provided brand voice, or a sane default?
- Should auto-fire be **off by default** (every play escalates until the tenant opts into a
  threshold > 0)? Leaning yes — safest first-run posture.

---

## Out of scope (v1)

Other goal types; multi-channel; product-usage dormancy signals; natural-language parsing
of manager email replies; reinforcement learning; multi-agent orchestration.
