# Abe Self-Sets-Up Call Categories — Design (v1)

**Date:** 2026-06-04
**Status:** Approved design — ready for implementation planning.
**Builds on:** the shipped call pipeline + Calls feature — `suggestCategories` (`agent/abe/categorySuggest.ts`, returns `string[]`), `tagNewCalls` (`lineTagger.ts`), `upsertLineReportConfig({ taxonomy })`, the chat provider `makeLineChatProvider` (`lineChatTools.ts`), the `requireAdmin`/`tenantLlm` route pattern (`routes/callAnalytics.ts`), and the import/cron paths (`backfillCalls.ts`, `lineShift.ts`).

## Problem

A tenant only sees a category breakdown after a human hand-configures the taxonomy. Today Abe can *suggest* categories (`POST /api/calls/suggest-categories` + a "Let Abe suggest" button that feeds a suggest→edit→save→retag flow), but he can't **set them up himself**. New tenants (e.g. MPS — has calls, zero categories) stay stuck at an empty breakdown. Abe is an AI employee; naming the categories from the calls is his job.

## Approach

One orchestration function with three entry points, reusing the existing suggest + persist + tag primitives. Abe applies categories **autonomously** (a reversible "safe write", consistent with his existing settings tools) — never a send.

## Components — `server/src/agent/abe/setupCategories.ts` (new)

### `applyCategories(pool, tenantId, categories, opts?): Promise<{ categories: string[]; applied: boolean }>`
- Normalise: `map(trim)`, drop empties, dedupe (case-insensitive), cap each to 40 chars, cap list to 15.
- **Guard:** read current config; if its `taxonomy` is already non-empty and `opts?.replace !== true`, return `{ categories: <existing>, applied: false }` (never silently clobber a curated taxonomy).
- Else persist via `upsertLineReportConfig(pool, tenantId, { taxonomy: normalised })` (creates the config row if missing — this is what unblocks MPS) and return `{ categories: normalised, applied: true }`.
- No LLM, no tagging — pure config write.

### `setupCategories({ pool, tenantId, llm, model, categories?, replace? }): Promise<{ categories: string[]; tagged: number; applied: boolean }>`
The user-facing "do it all":
1. If `categories` not supplied → `categories = await suggestCategories({ pool, tenantId, llm, model })` (Abe derives them from the real calls).
2. `const { categories: final, applied } = await applyCategories(pool, tenantId, categories, { replace })`.
3. If `applied` → run `tagNewCalls({ pool, tenantId, llm, model, batch: 100 })` in a loop until it returns 0 (cap the loop), summing `tagged`.
4. Return `{ categories: final, tagged, applied }`.

### `ensureCategories({ pool, tenantId, llm, model }): Promise<string[]>`
The **automatic** path — derive+apply only when there's something to do, and do NOT tag (the caller tags next, so we avoid double work):
- Read config; if `taxonomy` is already non-empty → return it (no-op).
- Count inbound calls (`countCallsMatching` / a cheap `agent_messages` count); if zero → return `[]` (nothing to base categories on).
- Else `const cats = await suggestCategories(...)`; if `cats.length` → `applyCategories(pool, tenantId, cats, { replace: false })`; return the applied list (or `[]` if suggest produced nothing).

## Three triggers (all call the above)

### 1. Chat tool — `lineChatTools.ts`
Add a safe-write tool (mirrors `update_report_settings`):
- TOOLS entry: `{ name: 'setup_categories', description: 'Analyse the calls and set up the call categories (taxonomy) yourself, then sort existing calls into them. Optionally pass a specific list, or set replace:true to overwrite the current set.', parameters: { type:'object', properties: { categories: { type:'array', items:{type:'string'} }, replace: { type:'boolean' } } } }`.
- `case 'setup_categories'`: requires `llm`+`model` (provider's are optional) — if absent, `return ok({ error: 'Connect an OpenAI key first.' })`; else `return ok(await setupCategories({ pool, tenantId, llm, model, categories: args.categories, replace: args.replace }))`.
- **Wiring check:** confirm the chat route (`runAbeChat` / the agent-chat handler) constructs `makeLineChatProvider` WITH `llm`+`model`; if it currently omits them, pass them through (small fix) so the tool works in production.

### 2. Button + route
- `POST /api/calls/setup-categories` (admin, `tenantLlm`), mirroring `import-past`/`suggest-categories`:
  ```ts
  const body = z.object({ categories: z.array(z.string().min(1)).max(30).optional(), replace: z.boolean().optional() }).parse(req.body ?? {});
  const { llm, model } = await tenantLlm(app, ctx.tenantId);
  reply.send(await setupCategories({ pool: app.pool, tenantId: ctx.tenantId, llm, model, categories: body.categories, replace: body.replace }));
  ```
- Web client (`web/src/lib/calls.ts`): `autoSetupCategories = (opts?) => api<{ categories: string[]; tagged: number; applied: boolean }>('/api/calls/setup-categories', { method:'POST', body: JSON.stringify(opts ?? {}) })`.
- UI (`web/src/pages/Calls.tsx`, `FirstRunCard`, the empty-categories state): add a **primary** button **"Let Abe set them up for me"** → `autoSetupCategories()` → on success `onSaved(res.categories)` + toast *"Abe set up {categories.length} categories and sorted {tagged} calls."*. Keep the existing manual suggest→edit→save flow as the **secondary** option ("I'll set them up myself"). Loading/disabled while running; error toast on failure (don't lose the manual flow).

### 3. Automatic on first calls
Wire `ensureCategories` in BEFORE the existing tagging steps:
- `backfillCalls.ts::backfillCallsFromEmails` — after the import loop, before its `tagNewCalls` loop, `await ensureCategories({ pool, tenantId, llm, model })`. (So "Import past calls" now also auto-creates categories for an empty tenant.)
- `lineShift.ts::runLineReportShift` — before its `tagNewCalls(... batch:100)` call (line ~23), `await ensureCategories({ pool, tenantId, llm, model })`. (So the hourly/daily cron self-heals categories when a tenant starts getting calls.)
Both are guarded no-ops when a taxonomy already exists, so curated taxonomies are never touched and there's no extra LLM cost on steady-state runs.

## Safety
- Categories are a **reversible config write** (the existing category editor still edits/replaces them); not a send — the structural send-gate is untouched.
- `replace` guard means automatic/agent setup **never overwrites** a non-empty taxonomy.
- Call content stays **DATA** (existing `suggestCategories`/tagger posture; the new tool adds no new content sink).
- Route is **admin-gated + tenant-scoped**; bounded list (≤15, ≤40 chars each); `tenantLlm` requires the tenant's own OpenAI key.

## Testing
- `applyCategories`: normalises (trim/dedupe/cap); guard returns `applied:false` + keeps existing when taxonomy non-empty and `replace` not set; `replace:true` overwrites; creates a config row for a tenant that had none.
- `setupCategories` (stub LLM — suggest returns a category list, tagger returns parseable tags): derives when no list passed, applies, tags (`tagged>0`); passing an explicit list skips suggest; guard path returns `applied:false, tagged:0`.
- `ensureCategories`: empty taxonomy + has calls → applies + returns list; non-empty taxonomy → returns existing, no write; zero calls → `[]`, no write.
- Route `POST /api/calls/setup-categories`: 403 non-admin; 200 returns `{ categories, tagged, applied }`; respects `replace`.
- Chat tool: `setup_categories` advertised in `listTools`; calling it with a stub-LLM provider applies categories; missing-LLM returns the friendly error; **no send tool added** (structural-gate test still green).
- Automatic: `backfillCallsFromEmails` on an empty-taxonomy tenant ends with categories set + calls tagged; `runLineReportShift` ensures categories before tagging.
- Web: `cd web && npm run build` + `tsc --noEmit` (ignore pre-existing Domains/Segments errors).

## Out of scope (v1)
Abe auto-*merging*/renaming an existing taxonomy; per-category descriptions or examples; multi-language categories; surfacing the one-click setup inside `CategoriesPanel` (the empty-state `FirstRunCard` is the v1 home; ongoing edits keep the existing suggest/edit flow).

## Open questions for the build pass
- Confirm a cheap inbound-call count exists (`countCallsMatching` with empty filter, or add a tiny `countInboundCalls`) for `ensureCategories`' "has calls" check.
- Confirm `runAbeChat` passes `llm`+`model` into `makeLineChatProvider` (needed for the `setup_categories` tool at runtime); if not, thread them through.
