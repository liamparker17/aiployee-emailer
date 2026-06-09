# Abe Inbox Intelligence — Design

**Date:** 2026-06-09
**Status:** Approved (design), pending spec review
**Author:** Liam + Claude

## Problem

We launched our first successful campaign and discovered a blind spot: **inbound mail does not exist anywhere in the system.** Abe (the OpenAI tool-calling agent, `runToolLoop`, default model `gpt-4.1`) can read *sent* campaign emails, opens, and clicks — but recipient **replies never enter the system**. There is no IMAP/POP polling, no inbound webhook parse, and no schema to store a received message or link it to the campaign it answers.

We want Abe to read the inbox, monitor campaign responses, categorize them, and proactively suggest (and draft) next steps based on the *actual* replies.

## Goals

- Pull the tenant's real mailbox into the system over IMAP (the whole inbox, not just parse-routed replies).
- Persist inbound messages and **correlate each reply to the sent email / campaign / contact** it answers.
- Categorize each reply and let Abe **proactively** surface per-campaign rollups with suggested next steps.
- Let Abe **draft replies** that queue into the **existing approval flow** (no new approval mechanism).
- Give Abe chat tools so "what came back from the campaign?" works on demand.

## Non-Goals

- Real-time/instant reply push (IMAP polling on a cron is sufficient for v1; inbound webhooks are a possible later addition).
- A full webmail UI / threaded conversation viewer.
- Sending replies autonomously without human approval. Every outbound reply goes through the existing approval gate.
- Multi-folder/label management. v1 reads INBOX only.

## Key Decisions (confirmed with user)

1. **Mail source: IMAP read of the real mailbox.** Connect to the same account the tenant sends from and read the entire inbox.
2. **Access model: sync into DB, then search.** A fetch job pulls messages into `inbound_emails`; Abe greps/searches the DB. Enables correlation, categories, history, and fast repeat queries.
3. **Autonomy: proactive monitoring.** After the fetch+categorize cron runs, Abe writes per-campaign rollups into the existing feed without being asked.
4. **IMAP credentials: dedicated encrypted `imap_configs` table** (option A), mirroring the existing `smtp_configs` pattern, IMAP host auto-suggested from the SMTP host but overridable.
5. **Suggested next steps include drafting a reply**, queued into the existing approval flow for human approve/send.

## Architecture Overview

Three phases, each independently shippable. Phase 1 is the foundation; 2 and 3 build on it.

```
IMAP mailbox ──(cron: imapFetch)──▶ inbound_emails ──(correlate)──▶ emails / campaigns / contacts
                                          │
                                          ├──(categorize: gpt-4o-mini)──▶ category + summary + suggested_action
                                          │                                   │
                                          │                              auto-act (unsubscribe→suppression, bounce→mark)
                                          ▼                                   ▼
                                    Abe chat tools                      Abe feed rollups ──▶ draft reply (approval flow)
                              (search_inbox, get_campaign_responses)
```

### Existing patterns this reuses

- **Encrypted credentials:** `smtp_configs.password_encrypted` (bytea) via `ENC_KEY`. `imap_configs` mirrors this exactly.
- **SMTP transport lives in** `packages/core/src/send/dispatch.ts`. The IMAP fetch module is its inbound sibling in `packages/core/src/receive/`.
- **Cron + `CRON_SECRET`:** same guarded-route pattern as existing webhooks/auto-fire shifts.
- **Agent tools:** defined as `AgentTool` (`{ name, description, parameters }`, MCP-style) and dispatched through `compositeProvider()` → `provider.callTool(name, args)` (`server/src/agent/runner.ts`, `server/src/agent/abe/chatTools.ts`). New tools register through a provider exactly like the existing ones.
- **Classification model:** `gpt-4o-mini` (already used for call classification in `server/src/agent/abe/models.ts`).
- **Feed:** `server/src/agent/abe/feed.ts` already produces Abe's surfaced items.
- **Approval flow:** `agent_messages` (role/status, `approved_by`/`approved_at`) + `approvalToken.ts` + `approvalEmail.ts` + `execute.ts` + `PendingApprovals.tsx`. Drafted replies reuse this; they do not introduce a parallel path.

---

## Phase 1 — Inbox Ingestion (foundation)

### Schema

**`imap_configs`** (new migration, mirrors `smtp_configs`):

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `tenant_id` | uuid fk | |
| `sender_id` | uuid fk → `senders` | the mailbox this reads for; nullable if tenant-level |
| `host` | text | auto-suggested from SMTP host (`smtp.` → `imap.`), overridable |
| `port` | int | default 993 |
| `secure` | boolean | default true (TLS) |
| `username` | text | |
| `password_encrypted` | bytea | encrypted with `ENC_KEY`, same helper as smtp |
| `enabled` | boolean | lets a tenant toggle inbox reading off |
| `created_at` / `updated_at` | timestamptz | |

**`imap_sync_state`** (so we only fetch new mail):

| column | type | notes |
|---|---|---|
| `imap_config_id` | uuid fk | |
| `folder` | text | `'INBOX'` for v1 |
| `uid_validity` | bigint | IMAP UIDVALIDITY; if it changes, reset cursor |
| `last_seen_uid` | bigint | high-water mark |
| `last_synced_at` | timestamptz | |
| PK | (`imap_config_id`, `folder`) | |

**`inbound_emails`** (new migration):

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `tenant_id` | uuid fk | |
| `imap_config_id` | uuid fk | source mailbox |
| `imap_uid` | bigint | dedup within mailbox |
| `message_id` | text | RFC822 Message-ID |
| `in_reply_to` | text | nullable |
| `references` | text | nullable (space-joined) |
| `from_addr` | text | |
| `from_name` | text | nullable |
| `to_addr` | text | |
| `subject` | text | |
| `body_text` | text | nullable |
| `body_html` | text | nullable |
| `received_at` | timestamptz | from Date header |
| `email_id` | uuid fk → `emails` | nullable — the sent email this replies to |
| `campaign_id` | uuid fk → `campaigns` | nullable — denormalized from `email_id` |
| `contact_id` | uuid fk → `contacts` | nullable — matched recipient |
| `category` | text | nullable — set in Phase 2 |
| `category_confidence` | real | nullable |
| `summary` | text | nullable |
| `suggested_action` | text | nullable |
| `status` | text | `'new' / 'processed' / 'actioned'` |
| `created_at` | timestamptz | |

Indexes: unique `(tenant_id, message_id)`, unique `(imap_config_id, imap_uid)`, `(tenant_id, received_at DESC)`, `(campaign_id)`, `(email_id)`, `(category)`.

### Fetch module — `packages/core/src/receive/imapFetch.ts`

- Uses `imapflow` (connect/auth) + `mailparser` (parse RFC822 → headers + text/html).
- For each enabled `imap_configs` row: open INBOX, check UIDVALIDITY against `imap_sync_state` (reset cursor if changed), fetch UIDs `> last_seen_uid`, parse, insert into `inbound_emails`, advance `last_seen_uid`.
- Idempotent: unique `(imap_config_id, imap_uid)` and `(tenant_id, message_id)` make re-runs safe.
- **Privacy:** never log bodies or full headers; log counts and message-ids only at debug. Bodies stored in DB are tenant-isolated like all other tables.
- Bounded per run (e.g. max N messages/config) to keep cron within the function timeout; cursor means the next run continues.

### Correlation (the part that makes it "campaign replies")

For each new inbound, in order:
1. **Exact:** parse `In-Reply-To` / `References` message-ids, look up `emails.message_id` (already indexed). On hit, set `email_id`, then `campaign_id` and `contact_id` from that email.
2. **Fallback:** `from_addr` matches a `contacts.email` for the tenant **and** subject starts with `Re:`/`RE:` → link `contact_id`, and best-effort `campaign_id` = that contact's most recent campaign send within a window (e.g. 30 days).
3. **None:** leave correlation columns null — still stored and searchable (it's "the whole inbox").

### Cron route

- New guarded route (e.g. `/api/cron/imap-fetch`), `CRON_SECRET`-checked, iterates tenants with enabled IMAP configs and runs the fetch module. Same shape as existing cron/webhook routes.

### Phase 1 done when

A tenant with IMAP creds gets new inbox messages synced into `inbound_emails` with correct correlation to sent campaign emails, verified against the real campaign mailbox.

---

## Phase 2 — Categorization + Abe's Tools

### Categorization

- After fetch, for each `status='new'` inbound, call `gpt-4o-mini` to produce:
  - `category` ∈ `interested / not_interested / question / unsubscribe / out_of_office / auto_reply / bounce / other`
  - `category_confidence` (0–1)
  - `summary` (one line)
  - `suggested_action` (free text, e.g. "Send pricing PDF", "Suppress and stop", "Reply answering delivery-time question")
- Set `status='processed'`.
- **Auto-actions on unambiguous categories** (reuse existing primitives): `unsubscribe` → add to suppression list + unsubscribe contact; `bounce` → mark the linked `emails` row / add suppression. These mirror the existing bounce/complaint webhook behavior in `v1Webhooks.ts`. Set `status='actioned'` when auto-handled.

### Abe chat tools (registered via the provider)

- `search_inbox({ query, days?, category? })` — full-text-ish search over `inbound_emails` (subject/body/from), filterable by category and recency; returns count + sample.
- `get_campaign_responses({ campaignId })` — category breakdown + sample replies for a campaign.
- `get_reply({ id })` — full single inbound message.

These replace/extend the current `lineChatTools.search_emails` (which only sees *sent* mail). System prompt (`prompt.ts`) gains a short paragraph telling Abe he can now read and reason over campaign replies.

### Phase 2 done when

In chat, "what came back from the <campaign>?" returns a correct categorized breakdown drawn from real replies, and an unsubscribe reply results in a suppression.

---

## Phase 3 — Proactive Monitoring + Drafting

### Feed rollups

- After the categorize step, the cron writes per-campaign rollup items to the Abe feed (`feed.ts`): e.g. *"12 replies to **Spring Outreach**: 4 interested, 2 unsubscribed, 1 question, 5 other — 3 suggested next steps."*
- Rollups are idempotent per (campaign, run window) so repeated cron runs update rather than duplicate.

### Drafted replies → existing approval flow

- For `interested` / `question` replies (above a confidence threshold), Abe drafts a reply and queues it as an `agent_messages` draft in the **existing approval flow** (`approved_by`/`approved_at`, `approvalToken.ts`, `approvalEmail.ts`, surfaced in `PendingApprovals.tsx`). The human approves → `execute.ts` sends via the normal SMTP path.
- No reply is sent without approval (see Non-Goals).

### Command Centre surface (light)

- A "Campaign Replies" view that lists categorized inbound per campaign with Abe's suggestion and a one-click "approve draft" entry point into the existing approvals UI. Kept thin — reuses existing approval components.

### Phase 3 done when

A new batch of replies produces a feed rollup, at least one drafted reply appears in pending approvals, and approving it sends through the normal path.

---

## Error Handling

- **IMAP auth/connection failure:** record an error state on the `imap_configs` row (or log + skip), surface a readiness warning (like Abe's existing "missing key/sender" readiness checks). One bad mailbox never blocks others.
- **UIDVALIDITY change:** reset the folder cursor and re-sync from a bounded recent window rather than refetching everything.
- **Categorization model failure:** leave `status='new'`; next cron retries. Never block ingestion on classification.
- **Correlation miss:** not an error — store uncorrelated.
- **Duplicate delivery:** unique constraints make all inserts idempotent.

## Security / Privacy

- IMAP passwords encrypted at rest with `ENC_KEY`, same helper as `smtp_configs`; never returned to the client in plaintext.
- Strict tenant isolation on every query (`tenant_id` scoping), consistent with existing tables.
- Reading a mailbox is sensitive: bodies are not logged; access is limited to the owning tenant's Abe context.
- New dependency review: `imapflow`, `mailparser` (note existing `nodemailer` high CVE follow-up — bundle a dependency audit pass with this work).
- A `security-review` pass is required before merge because this touches stored credentials, user input (untrusted email bodies → into the LLM and the DB), and auto-actions (suppression). Treat inbound bodies as untrusted: no HTML execution, guard against prompt-injection influencing auto-actions (auto-act only on high-confidence + keep human approval for any send).

## Testing

- **Unit:** correlation logic (In-Reply-To hit, fallback match, no-match); UIDVALIDITY reset; categorization output parsing; auto-action triggers.
- **Integration (serial, Neon test branch per project convention):** fetch module against a seeded `inbound_emails` flow with mocked IMAP; tool queries; draft → approval → send path.
- **Manual:** run the cron against the real campaign mailbox once Phase 1 lands.
- Follow the repo rule: Vitest runs serially against the Neon test branch; never two suites at once on the shared branch.

## Open Questions / Deferred

- Inbound webhook (instant push) deferred — IMAP cron is enough for v1.
- Multi-folder / Sent-folder reading deferred (INBOX only).
- Per-sender vs tenant-level mailbox: schema supports `sender_id` nullable for both; v1 wires per-sender for the campaign sender.

## Rough Build Order

1. Migrations: `imap_configs`, `imap_sync_state`, `inbound_emails`.
2. `imapFetch.ts` + correlation + cron route (Phase 1).
3. Categorization + auto-actions + Abe chat tools + prompt update (Phase 2).
4. Feed rollups + drafted-reply-into-approval + light Command Centre view (Phase 3).
5. `security-review` + dependency audit before merge.
