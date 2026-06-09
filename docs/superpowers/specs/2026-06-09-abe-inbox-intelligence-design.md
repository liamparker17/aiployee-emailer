# Abe Campaign Reply Intelligence — Design

**Date:** 2026-06-09
**Status:** Approved (design), pending spec review
**Author:** Liam + Claude

## Problem

We launched our first successful campaign and hit a blind spot: **inbound mail does not exist anywhere in the system.** Abe (OpenAI tool-calling agent, `runToolLoop`, default chat model `gpt-4.1`) can read *sent* campaign emails, opens, and clicks — but recipient **replies never enter the system.** There is no IMAP/POP polling, no inbound parse, and no schema to store a received message or link it to the campaign it answers.

Worse, per-individual-email handling would just recreate the grind of the per-line reports. What we actually want is **per-campaign analysis**: Abe monitors a campaign, reports the funnel, **groups the replies by the response they require**, and proposes one response per group — e.g. "45 people asked about opening hours → send them this; 5 are hot leads → handle individually."

## Goals

- Pull the tenant's real mailbox into the system over IMAP (the whole inbox, not just parse-routed replies).
- Persist inbound messages and **correlate each reply to the sent email / campaign / contact** it answers.
- Produce a **per-campaign funnel**: sent → opened → replied → hot leads.
- **Group replies by required response** (cluster + validate), and for each group let Abe propose one response.
- Keep the bulk parse/cluster **as cheap as possible** — this processes hundreds of thousands of tokens.
- Let Abe **propose, then ask** per group: one batch email to everyone, or individually personalised drafts — either queued into the **existing approval flow** before anything sends.

## Non-Goals

- Real-time reply push (IMAP cron is enough for v1; inbound webhooks deferred).
- Per-individual-email categorization as the primary unit of work — analysis is per-campaign, grouped.
- Sending any reply without human approval.
- A full webmail / threaded-conversation UI. INBOX only, no folder/label management.

## Key Decisions (confirmed with user)

1. **Mail source: IMAP read of the real mailbox.**
2. **Access model: sync into DB, then analyze.** Replies land in `inbound_emails`; analysis runs over the DB.
3. **Unit of work: per-campaign analysis, replies grouped by required response** — not per-email classification.
4. **IMAP credentials: dedicated encrypted `imap_configs` table** (mirrors `smtp_configs`, IMAP host auto-suggested from SMTP host, overridable).
5. **Grouping engine: hybrid, accuracy-guarded.** Cheap embeddings propose clusters; a cheap-LLM label pass validates coherence, ejects misfits to a "needs review" bucket, and merges same-intent clusters. Embeddings never decide the response.
6. **Cheapest models.** Bulk reply text goes through a cheap **embeddings** model only; a cheap **chat** model (gpt-4.1-nano / gpt-4o-mini tier) is used sparingly to label/merge clusters and draft the per-group response. Bulk bodies never go through the chat model except small per-cluster samples.
7. **Per-group send mode is a choice Abe asks for.** He presents the funnel + groups + a plain-English outline, then per group asks "one email to everyone, or individually personalised drafts?" Both paths queue into the existing approval flow.

## Architecture Overview

Three phases, each independently shippable. Phase 1 is the foundation.

```
IMAP INBOX ─(cron: imapFetch)─▶ inbound_emails ─(correlate)─▶ emails / campaigns / contacts
                                      │
                                      ▼
                        ┌─────── Campaign Analysis (on demand / cron) ───────┐
                        │ 1. funnel: sent→opened→replied→hot leads           │
                        │ 2. embed replies (cheap embeddings)  ◀── bulk text │
                        │ 3. cluster (collapse near-dupes)                   │
                        │ 4. cheap-LLM label/merge/validate ─▶ reply_groups  │
                        │    misfits + low-confidence ─▶ "needs review"      │
                        │ 5. hot-lead flag (never batch-drafted)             │
                        └────────────────────────────────────────────────────┘
                                      │
                                      ▼
                     Abe proposes (feed + chat): funnel + groups + outline
                                      │  per group asks: batch vs individual
                                      ▼
                     draft(s) ─▶ EXISTING approval flow ─▶ SMTP send
```

### Existing patterns this reuses

- **Encrypted credentials:** `smtp_configs.password_encrypted` (bytea) via `ENC_KEY`. `imap_configs` mirrors it exactly.
- **Transport:** SMTP send lives in `packages/core/src/send/dispatch.ts`; the IMAP fetch module is its inbound sibling in `packages/core/src/receive/`.
- **Vector infra already exists** (RAG vector provider in `assembleTenantProviders`) — reused for reply embeddings/clustering rather than standing up new infra.
- **Cron + `CRON_SECRET`:** same guarded-route pattern as existing webhooks / auto-fire shifts.
- **Agent tools:** `AgentTool` (`{ name, description, parameters }`, MCP-style) dispatched via `compositeProvider()` → `provider.callTool(name, args)` (`server/src/agent/runner.ts`, `chatTools.ts`). New tools register through a provider exactly like existing ones.
- **Cheap models:** `gpt-4o-mini` already used for call classification in `server/src/agent/abe/models.ts`.
- **Feed:** `server/src/agent/abe/feed.ts` surfaces Abe's items.
- **Approval flow:** `agent_messages` (`approved_by`/`approved_at`) + `approvalToken.ts` + `approvalEmail.ts` + `execute.ts` + `PendingApprovals.tsx`. Group drafts reuse this path; no parallel mechanism.

---

## Phase 1 — Inbox Ingestion (foundation)

### Schema

**`imap_configs`** (mirrors `smtp_configs`): `id`, `tenant_id`, `sender_id` (fk→`senders`, nullable for tenant-level), `host` (auto-suggested `smtp.`→`imap.`, overridable), `port` (default 993), `secure` (default true), `username`, `password_encrypted` (bytea, `ENC_KEY`), `enabled`, `created_at`/`updated_at`.

**`imap_sync_state`** (only fetch new mail): PK (`imap_config_id`, `folder`), `uid_validity` (bigint), `last_seen_uid` (bigint), `last_synced_at`. `folder='INBOX'` in v1.

**`inbound_emails`**:

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `tenant_id` | uuid fk | |
| `imap_config_id` | uuid fk | source mailbox |
| `imap_uid` | bigint | dedup within mailbox |
| `message_id` | text | RFC822 Message-ID |
| `in_reply_to` / `references` | text | nullable |
| `from_addr` / `from_name` | text | |
| `to_addr` | text | |
| `subject` | text | |
| `body_text` / `body_html` | text | nullable |
| `received_at` | timestamptz | from Date header |
| `email_id` | uuid fk → `emails` | nullable — sent email this replies to |
| `campaign_id` | uuid fk → `campaigns` | nullable — denormalized from `email_id` |
| `contact_id` | uuid fk → `contacts` | nullable — matched recipient |
| `embedding` | vector | nullable — set during analysis (reuse existing vector column type) |
| `reply_group_id` | uuid fk → `reply_groups` | nullable — assigned during analysis |
| `group_fit` | text | nullable — `'fit' / 'misfit' / 'needs_review'` |
| `is_hot_lead` | boolean | default false — set during analysis |
| `status` | text | `'new' / 'analyzed'` |
| `created_at` | timestamptz | |

Indexes: unique `(tenant_id, message_id)`, unique `(imap_config_id, imap_uid)`, `(tenant_id, received_at DESC)`, `(campaign_id)`, `(email_id)`, `(reply_group_id)`.

### Fetch module — `packages/core/src/receive/imapFetch.ts`

- `imapflow` (connect/auth) + `mailparser` (RFC822 → headers + text/html).
- Per enabled `imap_configs` row: open INBOX, check UIDVALIDITY vs `imap_sync_state` (reset cursor on change), fetch UIDs `> last_seen_uid`, parse, insert, advance `last_seen_uid`. Idempotent via unique constraints. Bounded per run (max N/config) to fit the function timeout; cursor continues next run.
- **Privacy:** never log bodies/full headers (counts + message-ids at debug only).

### Correlation

1. **Exact:** `In-Reply-To`/`References` message-ids → `emails.message_id` (indexed). On hit set `email_id`, then `campaign_id`/`contact_id` from that email.
2. **Fallback:** `from_addr` matches a tenant `contacts.email` **and** subject starts `Re:` → set `contact_id`, best-effort `campaign_id` = that contact's most recent send within 30 days.
3. **None:** stored uncorrelated, still searchable.

### Cron route

`/api/cron/imap-fetch`, `CRON_SECRET`-guarded, iterates tenants with enabled IMAP configs. Same shape as existing cron/webhook routes.

**Phase 1 done when:** a tenant's new INBOX mail syncs into `inbound_emails` with correct correlation to sent campaign emails, verified against the real campaign mailbox.

---

## Phase 2 — Campaign Analysis (funnel + grouping)

A campaign analysis run (on demand from chat, and/or scheduled per monitored campaign) over that campaign's correlated replies.

### Tables

**`campaign_analyses`**: `id`, `tenant_id`, `campaign_id`, `run_at`, `status` (`'running'/'ready'/'failed'`), funnel snapshot (`sent_count`, `opened_count`, `replied_count`, `hot_lead_count`), `model_cost_note` (debug). One latest-per-campaign superseding prior runs (or kept as history).

**`reply_groups`**: `id`, `tenant_id`, `campaign_analysis_id` fk, `label` (e.g. "Asking about opening hours"), `intent_summary`, `size`, `confidence` (real), `proposed_outline` (what Abe would send), `send_mode` (nullable `'batch'/'individual'` — set when user chooses), `draft_status` (`'none'/'drafted'/'queued'/'sent'`). A special standing group per analysis: **"Needs your review"** for misfits/low-confidence.

### Pipeline (cost-optimized, accuracy-guarded)

1. **Funnel** — computed from `emails` (sent), `email_events` (opened/clicked), `inbound_emails` (replied), `is_hot_lead`. Cheap SQL, no model.
2. **Embed** — embed each not-yet-embedded reply with the cheap **embeddings** model; store in `inbound_emails.embedding`. *This is the only step the bulk text touches a model, and embeddings are ~5x cheaper than the cheapest chat model per token.*
3. **Cluster** — group by cosine similarity to collapse near-duplicates / near-identical asks. Deterministic, no model cost. Produces candidate clusters + outliers.
4. **Label / merge / validate (cheap chat model, batched)** — for each candidate cluster, pass a *small sample* (not all bodies) to label the shared intent, write `proposed_outline`, and **validate coherence**: merge clusters that are the same intent; mark members that don't fit as `group_fit='misfit'` and move them to **Needs your review**; clusters below a confidence threshold collapse into Needs your review rather than getting a response. This is the safeguard against embedding-driven inaccuracy — the LLM, not the vector math, confirms what a group is and who belongs in it.
5. **Hot-lead detection** — buying-signal replies flagged `is_hot_lead=true`; surfaced as their own group and **never batch-drafted**.

### Abe chat tools (via provider)

- `analyze_campaign({ campaignId })` — run/refresh the analysis; returns funnel + groups summary.
- `get_campaign_groups({ campaignId })` — groups with label, size, confidence, outline.
- `search_inbox({ query, days? })` — general inbox search (replaces sent-only `lineChatTools.search_emails`).
- `get_reply({ id })` — full single inbound message.

`prompt.ts` gains a short paragraph: Abe analyzes campaigns by funnel + reply groups, proposes one response per group, and always asks batch-vs-individual before drafting.

**Phase 2 done when:** "analyze the <campaign>" returns a correct funnel and a set of coherent reply groups with outlines, with ambiguous replies parked in "Needs your review," verified against real replies.

---

## Phase 3 — Proposal, Mode Choice, Drafting → Approval

### Proposal

After analysis, Abe surfaces (feed via `feed.ts` + in chat) a per-campaign proposal: the funnel, each group (label, size, outline), the hot-lead list, and the "Needs your review" bucket. Feed rollup is idempotent per (campaign, analysis).

### Per-group mode choice

For each actionable group Abe asks: **"one email to everyone, or individually personalised drafts?"**

- **Batch** → one template (name/merge-field personalized) drafted once; on approval, sends to all `group_fit='fit'` members of the group via the normal SMTP path. One approval per group.
- **Individual** → Abe expands the group into a per-recipient draft (personalised), each queued so you can tweak before sending.

Either way drafts queue as `agent_messages` in the **existing approval flow** (`approved_by`/`approved_at`, `approvalToken.ts`, `approvalEmail.ts`, `PendingApprovals.tsx`); approval triggers `execute.ts` send. Hot leads default to individual.

### Command Centre surface (light)

A "Campaign Replies" view per campaign: funnel, groups with outline + size, the review bucket, and a one-click entry into the existing approvals UI. Thin — reuses existing approval components.

**Phase 3 done when:** an analyzed campaign yields a proposal; choosing batch on a group produces one approvable draft that, on approval, sends to the whole fit-group; choosing individual produces per-recipient drafts; nothing sends without approval.

---

## Cost Notes

- Bulk reply text → **embeddings only** (cheapest tier). Chat-model tokens limited to: small per-cluster samples for labeling, and the per-group draft(s). This is the difference between "feed 80–800 bodies through a chat model every run" and "feed them through embeddings once, then a few cheap calls."
- Embeddings cached on `inbound_emails.embedding` — re-runs don't re-embed.
- Clustering is deterministic (no model cost). Re-analysis only re-labels changed clusters.
- Batched label calls (multiple clusters per request) to amortize overhead.

## Accuracy Safeguards (addresses the clustering-accuracy concern)

- Embeddings **propose**; the cheap-LLM label pass **decides** group membership and intent.
- Any reply not confidently matching its group's intent → `misfit`/`needs_review`, excluded from batch sends.
- Low-confidence clusters never get a batch response — they go to "Needs your review."
- Hot leads are never batch-drafted.
- Abe shows the grouping + outline and **asks before drafting**, so a human validates the grouping before any text is written or sent.
- Nothing sends without explicit approval (every draft through the existing gate).

## Error Handling

- **IMAP auth/connection failure:** record error on the `imap_configs` row + readiness warning (like Abe's existing missing-key/sender checks); one bad mailbox never blocks others.
- **UIDVALIDITY change:** reset folder cursor, re-sync a bounded recent window.
- **Embedding/label failure:** leave affected replies `status='new'`; next run retries. Never block ingestion on analysis.
- **Correlation miss / cluster outlier:** not errors — stored uncorrelated / parked in review.
- **Duplicate delivery:** unique constraints make inserts idempotent.

## Security / Privacy

- IMAP passwords encrypted at rest (`ENC_KEY`, same helper as `smtp_configs`); never returned in plaintext.
- Strict `tenant_id` scoping on every query.
- Inbound bodies are **untrusted input** flowing into the LLM and DB: no HTML execution; guard against prompt-injection steering grouping or drafts (sample-based labeling + human approval before any send limits blast radius); auto-actions limited to nothing destructive in v1 (no auto-suppress here — suppression only via explicit user action or existing bounce/complaint webhook).
- New deps `imapflow`, `mailparser` reviewed; bundle the outstanding `nodemailer` (high) CVE bump into this work's dependency audit.
- **`security-review` required before merge** — touches stored credentials, untrusted input, and bulk send.

## Testing

- **Unit:** correlation (exact / fallback / none); UIDVALIDITY reset; clustering thresholds; label-pass misfit ejection + merge; funnel math; hot-lead flagging.
- **Integration (serial, Neon test branch):** fetch with mocked IMAP; analysis pipeline over seeded replies; batch draft → approval → send; individual draft path. Never run two suites at once on the shared branch.
- **Manual:** run the cron + an analysis against the real campaign mailbox after Phase 1/2 land.

## Open Questions / Deferred

- Inbound webhook (instant push) deferred — IMAP cron suffices for v1.
- Multi-folder / Sent reading deferred (INBOX only).
- Clustering algorithm specifics (similarity threshold vs HDBSCAN-style) settled during implementation against real reply data; the label/validate pass makes the design robust to a simple threshold start.
- Hot-lead definition (buying-signal heuristics) refined during Phase 2 against real replies.

## Rough Build Order

1. Migrations: `imap_configs`, `imap_sync_state`, `inbound_emails`.
2. `imapFetch.ts` + correlation + cron route (Phase 1).
3. `campaign_analyses` + `reply_groups`; embed → cluster → label/validate pipeline; funnel; Abe chat tools + prompt update (Phase 2).
4. Proposal feed/chat + per-group batch-vs-individual choice + drafting into approval + light Command Centre view (Phase 3).
5. `security-review` + dependency audit before merge.
