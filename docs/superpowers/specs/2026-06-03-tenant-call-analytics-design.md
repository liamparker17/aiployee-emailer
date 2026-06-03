# Tenant Call Analytics — Design (v1)

**Date:** 2026-06-03
**Status:** Approved design — ready for implementation planning.
**Builds on:** the shipped ABSA line-reporting/handover work — `agent_messages` (inbound call summaries), `line_call_tags` (tag-once categorisation), `lineTagger.ts` (`tagNewCalls`), `lineReportConfigs.ts` (per-tenant `taxonomy`), `lineCallTags.ts` (`aggregateByCategory`), and the chat tool pattern (`lineChatTools.ts`).

---

## The thesis

The product fields calls via Jobix; each call lands as an inbound `agent_messages` row whose `content` is the call **summary**. Today that's categorised and reported *to a client (ABSA)*. But the tenant themselves need to **interrogate their own calls**: "how many were general enquiries vs policy queries vs claims," read the substance of any call, and ask one-off questions. This spec adds a **tenant-facing Call Analytics view** — self-service, the tenant's own categories — reusing the existing categorisation plumbing. **No new tables.**

This is generic: every tenant gets it, against their own taxonomy. (ABSA reporting is one tenant's use of the same per-tenant categorisation; this view is the tenant's own lens on the same tags.)

---

## Locked decisions (2026-06-03)

1. **Both a dashboard and ask-anything.** A standing category breakdown (counts + %) PLUS an "ask Abe anything" box for one-off questions.
2. **Abe suggests categories, the tenant owns them.** Abe samples recent call summaries and proposes a starter category list; the tenant edits/approves; Abe then tags every call into them.
3. **On-demand re-tag.** Changing categories triggers a re-tag of historical calls into the current taxonomy (bounded batches). New calls keep auto-tagging on the existing cron.
4. **Dedicated "Calls" page** in the tenant nav, gated to `tenant_admin` + `super_admin` (tenant_user read-only is a fast-follow).
5. **Reuse, don't rebuild:** `line_call_tags` is the single per-tenant categorisation used by both ABSA reporting and this view; `taxonomy` lives in `line_report_configs`.

---

## Components

### 1. Categories — suggest / edit / re-tag (server)

- `server/src/agent/abe/categorySuggest.ts` — `suggestCategories({ pool, tenantId, llm, model, sample })`: pulls a sample of recent inbound summaries, asks the LLM to propose 5–8 concise category names (call content fenced as untrusted data), returns `string[]`. Does NOT persist — the tenant approves first.
- `server/src/repos/callAnalytics.ts` — `sampleInboundContents(pool, tenantId, n)` (recent summaries for the suggestion), and `deleteTagsForTenant(pool, tenantId)` (for re-tag).
- **Re-tag** `server/src/agent/abe/retag.ts` — `retagCalls({ pool, tenantId, llm, model, cap })`: `deleteTagsForTenant` then loop `tagNewCalls` (which tags untagged calls into the current `taxonomy`) in batches until done or `cap` (default 500) reached; returns `{ retagged, remaining }`. The existing cron re-tags any remainder over time. (Cost scales with call volume — bounded + on-demand only.)
- Taxonomy read/write reuses `getLineReportConfig` / `upsertLineReportConfig` (`taxonomy` field). Suggesting does not change the taxonomy; the tenant saves via the existing settings upsert.

### 2. Dashboard / breakdown (server)

- Reuse `aggregateByCategory(pool, tenantId, start, end)` → counts per category; the route computes % + total. Windows: Today / 7d / 30d (server resolves to `[start, end)`).
- A small per-day series: `callsPerDay(pool, tenantId, start, end)` in `callAnalytics.ts` (group `line_call_tags.created_at::date`).

### 3. Call explorer — the substance (server)

- `callAnalytics.ts` → `listCalls(pool, tenantId, { category?, search?, from?, to?, limit, offset })`: joins `agent_messages` (role='inbound') ⨝ `line_call_tags`, filters by category / date range / `content ILIKE %search%`, paginated (default limit 50), newest first. Returns `{ id, created_at, content, category, severity }[]` + a total count.
- `getCall(pool, tenantId, id)` → the full summary for the detail view.

### 4. Ask Abe anything (server)

- Add a `search_calls` tool to the existing Abe chat provider (`lineChatTools.ts`): `search_calls(text, windowDays)` → count + a few example summaries where `content ILIKE %text%`. Combined with the existing `top_call_reasons` / `query_calls` (category counts), Abe answers both category questions (instant, from tags) and substance questions (live scan). The Calls page's "Ask Abe" box posts to the existing chat endpoint (admin, scoped prompt) OR a thin `POST /api/calls/ask` that runs the same tool loop — default: reuse the chat endpoint to avoid a second agent path.

### 5. Endpoints (`server/src/routes/callAnalytics.ts`, admin-gated, tenant-scoped)

- `GET /api/calls?category=&search=&from=&to=&limit=&offset=` → `{ calls, total }`.
- `GET /api/calls/:id` → `{ call }`.
- `GET /api/calls/breakdown?window=today|7d|30d` → `{ total, byCategory, perDay }`.
- `GET /api/calls/categories` → `{ categories }` (the tenant taxonomy).
- `PUT /api/calls/categories` → save taxonomy (reuse `upsertLineReportConfig`).
- `POST /api/calls/suggest-categories` → `{ suggested }` (Abe proposes; not persisted).
- `POST /api/calls/retag` → `{ retagged, remaining }`.
- All gated by the existing `requireAdmin` (tenant_admin/super_admin) + tenant scope. Wire alongside `registerLineReportRoutes`.

### 6. Web — the Calls page

- `web/src/lib/calls.ts` — client methods for the endpoints above.
- `web/src/pages/Calls.tsx` (+ nav entry in `AppShell.tsx` under the tenant nav, admin-only), composed of small panels:
  - **Breakdown panel:** window selector (Today/7d/30d) + a counts/% table (or simple bars) + a calls-per-day mini-trend. States: empty ("No calls yet"), loading, populated, error.
  - **Categories panel:** the editable list; **Suggest with Abe** button (→ shows proposed list to accept/merge), **Save**, **Re-tag all calls** (with a confirm + progress/result toast).
  - **Call explorer:** search box + category filter + date range → paginated table (date · category chip · severity · excerpt) → row click opens a drawer/modal with the full summary. All 6 states.
  - **Ask Abe box:** a single input → posts the question, shows Abe's answer (+ any listed calls).

---

### 7. Customer-friendly UX — non-negotiable

**End user:** a non-technical ops / call-centre manager. Bar = *"I understand this in 5 seconds."* Plain language, guided, generous explanations, big obvious actions.

- **Guided first-run (the make-or-break):** with no categories set, the page leads with a single warm setup card — *"See what your callers are calling about. Abe can suggest categories from your calls."* → **Let Abe suggest** → review/tweak → **Save** → auto re-sort → the breakdown appears. ~20 seconds, no jargon. Never a bare empty page.
- **All 6 states on every panel** (empty / loading / populated / error / disabled / confirm). Empty states teach the next action; loading uses skeletons; errors are plain-language **with the fix** (e.g. *"Abe needs an OpenAI key to suggest categories — add one in Settings"* + link), never raw codes.
- **Plain language, zero internal jargon:** "categories" (not taxonomy/tags), "calls" (not messages), **"Re-sort all calls"** (not re-tag). Every panel has a one-line friendly explainer.
- **Friendly Abe presence:** *"Abe read your recent calls and suggests these categories…"*; the Ask box shows example prompts (*"Try: how many claims last week?"*).
- **Clear feedback:** success toasts (*"Sorted 240 calls into your categories"*), live progress/result on re-sort (`retagged`/`remaining`), buttons disabled + inline spinner while working; **never clear the user's input on error**.
- **At-a-glance breakdown:** counts **and %** with simple bars; top reasons obvious immediately.
- **Mobile-first + accessible:** cards on mobile / table on desktop; keyboard-navigable; ≥4.5:1 contrast; labels always visible; 8px spacing grid; reuse existing components (`PageHeader`, `Table`, `Modal`, `Button`, `Card`, `Skeleton`, `EmptyState`, `useToast`).

## Data flow

```
Jobix → agent_messages (inbound, content=summary)
   │
   ├─ cron tagNewCalls → line_call_tags (category/severity)  [existing]
   │
Calls page (tenant_admin):
   • Suggest categories ─▶ sample summaries ─▶ LLM ─▶ proposed list ─▶ tenant edits ─▶ save taxonomy
   • Re-tag all ─────────▶ delete tags ─▶ tagNewCalls (batched) ─▶ fresh line_call_tags
   • Breakdown ──────────▶ aggregateByCategory + callsPerDay
   • Explorer ───────────▶ listCalls (category/date/text filter, paginated) ─▶ getCall
   • Ask Abe ────────────▶ chat tool loop (query_calls + search_calls)
```

## Safety & cost

- **Untrusted data:** call content fenced as DATA in the suggestion + search prompts (existing posture).
- **Admin-gated, tenant-scoped:** every query `WHERE tenant_id = $1`; routes require admin.
- **Read-only analytics** (no sending). Re-tag is the only write beyond saving the taxonomy; it's bounded (`cap`) + on-demand, and idempotent-safe (delete-then-tag).
- **Cost:** suggestion = one bounded LLM call; re-tag = bounded LLM batches scaling with call volume (on-demand only); breakdown/explorer/search = plain SQL (cheap). Full-text search is `ILIKE` (fine at current volumes; a `pg_trgm`/tsvector index is a fast-follow if needed).

## Testing

- **Repo (Vitest, serial, Neon test branch):** `listCalls` filters by category/date/search + paginates; `sampleInboundContents` returns recent; `deleteTagsForTenant` clears only that tenant; `callsPerDay` buckets by day; tenant isolation on all.
- **Suggest (stub LLM):** returns the proposed category list from a sample.
- **Re-tag (stub LLM):** after `retagCalls`, every inbound call has a tag in the new taxonomy; counts reflect the new categories; cleared old tags don't linger.
- **search_calls tool:** counts calls whose content matches the text within the window.
- **Routes:** admin gate (403), cross-tenant isolation (404/empty), breakdown shape, retag returns counts.
- **Web:** `cd web && npm run build`.

## Out of scope (v1)

Charts library (simple bars/numbers + a basic trend); CSV export; tenant_user read-only access; per-call audio/transcript (summary only); cross-tenant analytics; a dedicated search index (ILIKE for now); fully-async re-tag for very high volumes (bounded synchronous + cron remainder for v1).

## Open questions for the build pass

- Confirm the "Ask Abe" box reuses the existing chat endpoint vs a thin `/api/calls/ask` — default reuse to avoid a second agent path; revisit if the chat persona/prompt doesn't fit a calls-only scope.
- Re-tag `cap` (default 500) — tune to typical tenant volume; surface "N remaining, finishing on schedule" when capped.
