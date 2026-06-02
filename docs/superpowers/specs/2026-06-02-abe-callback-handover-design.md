# Abe — ABSA Callback Handover — Design (v1)

**Date:** 2026-06-02
**Status:** Approved design — ready for implementation planning.
**Builds on:** Abe's "Client Line Intelligence & Advisory" (shipped) — the tagger (`server/src/agent/abe/lineTagger.ts`), the structural send-gate (`lineSend.ts`, only an approve action emails the client), `line_report_configs` (ABSA `recipients`), and the hourly `/v1/cron/line-report` job. Source data: inbound call summaries in `agent_messages` (`role='inbound'`, `source='jobix'`), `content` = free-text summary.

---

## The thesis (why this is the centrepiece)

First Assist fields the **ABSA iDirect line** — *overflow* from ABSA's own customer care. A (usually frustrated) customer calls; First Assist picks up but **cannot resolve the issue**. Their entire deliverable is to **capture the caller's details and hand them to ABSA so ABSA can call the customer back.** Every unresolved overflow call = one callback request that must reach ABSA, cleanly and fast, with nothing dropped.

Today that's manual: an agent scribbles a name and number, someone later compiles an email/spreadsheet to ABSA, and everyone hopes nothing slipped. Customers wait; there's no visibility on what's outstanding; handovers are inconsistent.

**Abe turns this into a one-click, accountable pipeline.** The moment a call summary lands, Abe writes ABSA's callback ticket — caller, number, account ref, reason, urgency, vulnerability, a clean summary, and the recommended ABSA action — and drops it into a **prioritised queue**. The operator approves; it's emailed to ABSA's callback intake **immediately**. A live SLA view shows exactly who is still waiting and for how long. This is the "I want Abe" hook for First Assist: instant, consistent, zero-drop handovers — making them look like ABSA's best overflow partner.

---

## Locked decisions (2026-06-02)

1. **Centrepiece, built next** — ahead of the outbound-analysis button and the rest of the call-analyser roadmap.
2. **One handover per inbound call.** Abe creates a `pending` handover for each new inbound call; the rare "resolved on the call / no ABSA follow-up needed" is marked `dismissed` (with a reason).
3. **Per-call delivery on approval.** Each approved handover is emailed to ABSA **immediately** (not batched) — best for SLA and urgent callers.
4. **Abe never invents caller details.** If name/number/account isn't in the summary, the field is left empty and recorded in `missing_fields`; the queue flags it so the agent fills it before forwarding.
5. **Reuse the ABSA `recipients`** from `line_report_configs` as the callback intake (no separate address in v1).
6. **Required fields = name, phone, reason** (drive the missing-field flags); account ref is optional. **Repeat-caller window = 7 days.** Hard-coded constants in v1 (configurable later).
7. **One new table** (`call_handovers`); reuse the existing send-gate, default-sender resolution, and tenant OpenAI key/model.
8. **Structural send-gate preserved.** Extraction and the queue can only create `pending` handovers; only the forward endpoint emails ABSA.

---

## The flow

Inbound call → Jobix → `agent_messages` (`role='inbound'`).

### EXTRACT (scheduled, frequent)
For each new inbound message with no `call_handovers` row, Abe runs an LLM extraction over the free-text summary and writes one handover:
- `caller_name`, `caller_phone`, `account_ref` — extracted verbatim where present; **left null and listed in `missing_fields` when absent (never invented).**
- `reason_category` (the existing taxonomy), `summary` (a crisp one-paragraph restatement), `urgency` (`low`/`med`/`high`), `vulnerable` (bool — elderly/distressed/hardship/at-risk language), `recommended_action` (what ABSA should do, e.g. "reverse duplicate debit; call back within 4h"), `needs_followup` (bool — false ⇒ created as `dismissed`).
- Idempotent: unique on `message_id`, so re-runs add nothing.
- Call content is fenced as **untrusted DATA**, never instructions.

### QUEUE (the operator surface)
Handovers with `status='pending'` form the **"Callbacks to forward to ABSA"** queue, ordered **urgency desc, then oldest first** (longest-waiting urgent callers on top). Each shows the ticket, time-waiting (SLA), missing-field warnings, and a repeat-caller flag.

### FORWARD (per call, on approval)
Operator approves → Abe emails the handover to ABSA's `recipients` via the existing send pipeline, **atomically** (claim `pending → forwarded` before sending, so no double-send), stamps `forwarded_at` + `email_id`, status → `forwarded`. Reject path = `dismissed` + reason.

---

## Data model — new table `call_handovers` (`tenant_id` FK, cascade)

- `id` uuid pk, `tenant_id` uuid
- `message_id` uuid FK `agent_messages(id)` ON DELETE CASCADE — **unique** (one handover per call)
- `caller_name` text, `caller_phone` text, `account_ref` text  *(nullable — extracted)*
- `reason_category` text, `summary` text, `recommended_action` text
- `urgency` text check in (`low`,`med`,`high`) default `med`
- `vulnerable` boolean default false
- `missing_fields` jsonb default `[]` — required fields not found (e.g. `["caller_phone"]`)
- `repeat_of` uuid null — references an earlier handover with same phone/account in the window (flag, not FK-enforced)
- `status` text check in (`pending`,`forwarded`,`dismissed`) default `pending`
- `approved_by` uuid FK `users(id)` ON DELETE SET NULL, `forwarded_at` timestamptz, `email_id` uuid
- `dismiss_reason` text, `created_at` timestamptz default now()
- Indexes: `(tenant_id, status, urgency, created_at)`; `(tenant_id, caller_phone)` and `(tenant_id, account_ref)` for repeat detection.

---

## Components (server)

- `server/src/repos/callHandovers.ts` — `insertHandover` (idempotent), `listHandovers(status?)`, `getHandover`, `setHandoverStatus`, `listUnextractedInbound(limit)`, `findRecentByCaller(phone, accountRef, sinceDays)` for repeat detection.
- `server/src/agent/abe/handoverExtract.ts` — `extractHandovers({ pool, tenantId, llm, model, batch })`: pulls un-extracted inbound, classifies + extracts fields (never-invent), computes `missing_fields` against the required set, sets `repeat_of`, inserts. Returns count.
- `server/src/agent/abe/handoverSend.ts` — `forwardHandover({ pool, encKey, baseUrl, tenantId, handoverId, approvedBy })`: mirrors `lineSend.ts` (read-only checks → atomic `pending→forwarded` claim → send to `recipients` via `queueEmail`/`claimForSend`/`dispatchEmail` → stamp). **Only sender.**
- Cron `/v1/cron/abe-handovers` (vercel.json, **every 5 minutes**) — runs `extractHandovers` for each enabled `line_report_configs` tenant (mirrors the line-report cron loop). Frequent cadence keeps the queue fresh for SLA. *(Real-time extraction on Jobix ingest is a fast-follow — see Data dependency.)*
- Routes (`server/src/routes/callHandovers.ts`, admin-gated, tenant-scoped): `GET /api/agent/handovers?status=`, `GET /:id`, `PATCH /:id` (edit fields / fill missing while `pending`), `POST /:id/forward`, `POST /:id/dismiss` (reason). Wire alongside `registerLineReportRoutes`.

## Components (web)

- `web/src/lib/abe.ts` — `Handover` type + `getHandovers`, `forwardHandover`, `patchHandover`, `dismissHandover`.
- `web/src/components/abe/CallbackHandoverPanel.tsx` — the queue at the **top of `AbeHome`** (above the line-reporting panel): SLA banner ("N waiting > 2h"), prioritised cards (ticket + time-waiting + missing-field chips + repeat flag), **Forward / Edit / Dismiss** actions, and a collapsed "Forwarded today" list. Admin-only; all 6 states.

---

## Reporting gravy

The existing digest composer gains handover throughput in its metrics: count forwarded in the period, average time-to-forward, and top reasons — so ABSA's account team gets the overflow picture without extra work. (Additive to `composeDigest` metrics; no new surface.)

---

## Safety & privacy

- **Untrusted data:** extraction prompt fences call content as data, never instructions.
- **Never invent:** missing caller fields stay null + flagged; the model is instructed not to guess names/numbers/accounts.
- **Structural send-gate:** extraction + queue create only `pending`; only `POST /:id/forward` emails ABSA (atomic claim prevents double-send). Provable by test.
- **POPIA:** the feature's purpose is forwarding caller details to the **data controller (ABSA)** for follow-up — appropriate — but data stays tenant-scoped and is sent only on operator approval to the configured ABSA recipients. No caller PII leaves except inside an approved handover.
- **Admin-gated**, bounded LLM (batch + token caps), every action audited (status timestamps + `email_id`).

## Data dependency (flagged)

Only the **free-text** `agent_messages.content` is persisted today; Jobix's structured `context` (POST `/v1/agent/messages`) — where a clean name/number/account could come from — is **not stored**. v1 extracts from text + flags gaps. **Fast-follow:** persist Jobix `context` (a `context jsonb` column on `agent_messages`, populated at ingest) so extraction reads structured fields first and falls back to text — making the handover fields far more reliable. Noted, not in v1 scope.

## Testing

- **Repo:** insert idempotency (one per `message_id`); `listUnextractedInbound` excludes handed-over; `findRecentByCaller` matches within window.
- **Extraction (stub LLM):** fields populate; a summary missing a phone leaves `caller_phone` null and `missing_fields=["caller_phone"]`; `needs_followup=false` ⇒ `dismissed`; a second call from the same number sets `repeat_of`.
- **Send-gate safety:** running extraction creates **zero** `emails` rows — only `POST /:id/forward` sends.
- **Forward:** atomic — a second forward of the same id returns 400 and sends no second email; status → `forwarded`, `email_id` set.
- **Routes:** admin gate (403), cross-tenant isolation (404), dismiss sets reason.
- **Web:** `cd web && npm run build`.

## Out of scope (v1)

Batched/cadenced delivery; a separate callback-intake address; configurable required-fields/repeat-window UI (hard-coded v1); ABSA acknowledgement/round-trip status; real-time on-ingest extraction (fast-follow); persisting Jobix `context` (fast-follow).

## Open questions for the build pass

- Confirm the 5-minute cron cadence is acceptable on the Vercel plan (vs hourly) — tune if needed.
- Exact email format ABSA wants for a callback ticket — v1 uses a clean labelled block; adjust to ABSA's intake template when known.
