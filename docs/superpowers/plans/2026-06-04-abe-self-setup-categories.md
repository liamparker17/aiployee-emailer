# Abe Self-Sets-Up Call Categories — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Abe set up a tenant's call categories himself — derive them from the real calls, apply them (a reversible safe-write), and tag existing calls — reachable from chat, a one-click button, and automatically on first calls.

**Architecture:** One new module `setupCategories.ts` with three functions (`applyCategories` pure write, `setupCategories` derive→apply→tag, `ensureCategories` auto-no-op guard). Three triggers call them: a `setup_categories` chat tool, `POST /api/calls/setup-categories` + a Calls-page button, and `ensureCategories` wired into the import + cron tag paths. Reuses existing `suggestCategories`, `upsertLineReportConfig({taxonomy})`, and `tagNewCalls`.

**Tech Stack:** TypeScript, Fastify, `pg`, Vitest (serial, Neon test branch), React. Spec: `docs/superpowers/specs/2026-06-04-abe-self-setup-categories-design.md`.

**Verified surfaces (from code):**
- `suggestCategories({pool,tenantId,llm,model,sample?}): Promise<string[]>` — `agent/abe/categorySuggest.ts` (returns ≤12).
- `tagNewCalls({pool,tenantId,llm,model,batch?}): Promise<number>` — `agent/abe/lineTagger.ts`. Call sites: `lineShift.ts:~23` (`runLineReportShift`), `backfillCalls.ts:~42`, `retag.ts:~15`.
- `upsertLineReportConfig(pool,tenantId,patch)` patch has `taxonomy?: string[]`; `getLineReportConfig(pool,tenantId)` returns row with `.taxonomy`.
- `makeLineChatProvider({pool,tenantId,llm?,model?})`; safe-write idiom `case 'update_report_settings': return ok(await upsertLineReportConfig(pool,tenantId,args as any))`; `ok = JSON.stringify`.
- Routes `callAnalytics.ts`: `requireTenantCtx(req)`, `requireAdmin(ctx)`, `tenantLlm(app,tenantId): {llm,model}`, `sendError`/`AppError`, `z`. Existing: `GET/PUT /api/calls/categories`, `POST /api/calls/suggest-categories`, `POST /api/calls/import-past`, `POST /api/calls/retag`.
- `countCallsMatching` exists in `repos/callAnalytics.ts` (use for the "has calls" check; verify its signature).
- Web `lib/calls.ts`: `getCategories`, `putCategories`, `suggestCategories`, `retagCalls`. `Calls.tsx`: `FirstRunCard` (~50-131) shown at the empty-categories state (~912-920); `useToast`, `Button`, `Spinner`, `friendlyError` available.

**Environment (every task):** repo root `C:\Users\liamp\Desktop\tools\Aiployee emailer`; branch `feature/abe-self-setup-categories`. Test one file: `cd "/c/Users/liamp/Desktop/tools/Aiployee emailer/server" && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/<file>`. **Before pushing: `npm -w server run build`** (strict tsc; vitest/tsx doesn't typecheck). Web: `cd web && npm run build && npx tsc --noEmit` (pre-existing Domains/Segments errors are OK; introduce none new). LSP-first read guard: call `mcp__ide__getDiagnostics()` once before the first `.ts`/`.tsx` Read, then Read scoped with offset+limit. Test helpers: `makePool`,`truncateAll` (`test/helpers/db.ts`), `createTenant` (`test/helpers/factories.ts`, returns `{id,name,slug}`), and the sender/email seeding used by `test/callIngestion.backfill.test.ts` if you need calls/emails.

---

## Task 1: `applyCategories` + `setupCategories` + `ensureCategories`

**Files:** Create `server/src/agent/abe/setupCategories.ts`; Test `server/test/setupCategories.test.ts`

- [ ] **Step 1: Failing test `server/test/setupCategories.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { getLineReportConfig, upsertLineReportConfig } from '../src/repos/lineReportConfigs.js';
import { mirrorEmailAsCall } from '../src/agent/abe/mirrorCall.js';
import { applyCategories, setupCategories, ensureCategories } from '../src/agent/abe/setupCategories.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

// stub LLM: suggest asks for {"categories":[...]}; tagger asks for {"tags":[...]}.
const stub = (cats: string[]) => ({
  chat: async (a: { messages: Array<{ content: string }> }) => {
    const text = a.messages.map(m => m.content).join(' ').toLowerCase();
    if (text.includes('categor')) return { content: JSON.stringify({ categories: cats }) };
    return { content: JSON.stringify({ tags: [] }) };
  },
});

async function seedCalls(tenantId: string, n: number) {
  for (let i = 0; i < n; i++) {
    await mirrorEmailAsCall({ pool, tenantId, emailId: `e${i}-${tenantId}`, summary: `caller about claim ${i}` });
  }
}

it('applyCategories normalises, guards overwrite, and can replace', async () => {
  const t = await createTenant(pool);
  const r1 = await applyCategories(pool, t.id, ['  Claims ', 'claims', 'Policy', '']); // dedupe+trim+drop empty
  expect(r1.applied).toBe(true);
  expect(r1.categories).toEqual(['Claims', 'Policy']);
  // guard: non-empty taxonomy not overwritten without replace
  const r2 = await applyCategories(pool, t.id, ['Other']);
  expect(r2.applied).toBe(false);
  expect((await getLineReportConfig(pool, t.id))?.taxonomy).toEqual(['Claims', 'Policy']);
  // replace overwrites
  const r3 = await applyCategories(pool, t.id, ['Other'], { replace: true });
  expect(r3.applied).toBe(true);
  expect((await getLineReportConfig(pool, t.id))?.taxonomy).toEqual(['Other']);
});

it('setupCategories derives from calls, applies, and tags', async () => {
  const t = await createTenant(pool);
  await seedCalls(t.id, 3);
  const r = await setupCategories({ pool, tenantId: t.id, llm: stub(['Claims', 'Policy', 'Complaints']) as any, model: 'gpt-4o' });
  expect(r.applied).toBe(true);
  expect(r.categories).toEqual(['Claims', 'Policy', 'Complaints']);
  expect(typeof r.tagged).toBe('number');
  expect((await getLineReportConfig(pool, t.id))?.taxonomy).toEqual(['Claims', 'Policy', 'Complaints']);
});

it('ensureCategories applies only when empty + has calls; no-op otherwise', async () => {
  const t = await createTenant(pool);
  // no calls → [] and no write
  expect(await ensureCategories({ pool, tenantId: t.id, llm: stub(['X']) as any, model: 'gpt-4o' })).toEqual([]);
  expect(await getLineReportConfig(pool, t.id)).toBeNull();
  // has calls + empty taxonomy → applies
  await seedCalls(t.id, 2);
  const cats = await ensureCategories({ pool, tenantId: t.id, llm: stub(['Claims', 'Policy']) as any, model: 'gpt-4o' });
  expect(cats).toEqual(['Claims', 'Policy']);
  // already set → no-op (stub would return different list, but it must NOT overwrite)
  const again = await ensureCategories({ pool, tenantId: t.id, llm: stub(['Totally', 'Different']) as any, model: 'gpt-4o' });
  expect(again).toEqual(['Claims', 'Policy']);
});
```

> Verify the stub `chat` shape matches what `suggestCategories` and `tagNewCalls` actually call (read both — they use `llm.chat({ model, messages })` returning `{ content }`). If `suggestCategories`'s prompt doesn't contain the substring "categor", adjust the stub's branch condition to a token that DOES appear in its prompt (read the prompt text). The point: suggest must return the category JSON, tagger must return parseable tag JSON.

- [ ] **Step 2: Run → FAIL (module missing).**

- [ ] **Step 3: Implement `server/src/agent/abe/setupCategories.ts`**

```typescript
import type pg from 'pg';
import { getLineReportConfig, upsertLineReportConfig } from '../../repos/lineReportConfigs.js';
import { suggestCategories } from './categorySuggest.js';
import { tagNewCalls } from './lineTagger.js';

interface LlmLike { chat(a: { model: string; messages: Array<{ role: string; content: string }> }): Promise<{ content: string }>; }

const MAX_CATEGORIES = 15;
const MAX_LEN = 40;

function normalise(categories: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of categories) {
    const v = (raw ?? '').trim().slice(0, MAX_LEN);
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= MAX_CATEGORIES) break;
  }
  return out;
}

export async function applyCategories(
  pool: pg.Pool, tenantId: string, categories: string[], opts?: { replace?: boolean },
): Promise<{ categories: string[]; applied: boolean }> {
  const next = normalise(categories);
  const cfg = await getLineReportConfig(pool, tenantId);
  const existing = cfg?.taxonomy ?? [];
  if (existing.length > 0 && opts?.replace !== true) return { categories: existing, applied: false };
  if (next.length === 0) return { categories: existing, applied: false };
  const saved = await upsertLineReportConfig(pool, tenantId, { taxonomy: next });
  return { categories: saved.taxonomy ?? next, applied: true };
}

export async function setupCategories(args: {
  pool: pg.Pool; tenantId: string; llm: LlmLike; model: string; categories?: string[]; replace?: boolean;
}): Promise<{ categories: string[]; tagged: number; applied: boolean }> {
  const proposed = args.categories && args.categories.length
    ? args.categories
    : await suggestCategories({ pool: args.pool, tenantId: args.tenantId, llm: args.llm, model: args.model });
  const { categories, applied } = await applyCategories(args.pool, args.tenantId, proposed, { replace: args.replace });
  let tagged = 0;
  if (applied) {
    for (let i = 0; i < 50; i++) {
      const n = await tagNewCalls({ pool: args.pool, tenantId: args.tenantId, llm: args.llm, model: args.model, batch: 100 });
      if (n === 0) break;
      tagged += n;
    }
  }
  return { categories, tagged, applied };
}

export async function ensureCategories(args: {
  pool: pg.Pool; tenantId: string; llm: LlmLike; model: string;
}): Promise<string[]> {
  const cfg = await getLineReportConfig(args.pool, args.tenantId);
  if ((cfg?.taxonomy?.length ?? 0) > 0) return cfg!.taxonomy;
  const { rows } = await args.pool.query<{ n: string }>(
    `SELECT count(*)::text n FROM agent_messages WHERE tenant_id = $1 AND role = 'inbound'`, [args.tenantId]);
  if (Number(rows[0].n) === 0) return [];
  const cats = await suggestCategories({ pool: args.pool, tenantId: args.tenantId, llm: args.llm, model: args.model });
  if (!cats.length) return [];
  const { categories } = await applyCategories(args.pool, args.tenantId, cats, { replace: false });
  return categories;
}
```

> Match the `pg`/`LlmLike` import conventions already used by `backfillCalls.ts`/`mirrorCall.ts`. If `LineReportConfigRow.taxonomy` is typed `string[] | null`, the `?? []` / `cfg!.taxonomy` handling above is correct; adjust if it's non-null.

- [ ] **Step 4: Run → PASS.**  **Step 5: `npm -w server run build` → PASS.**  **Step 6: Commit**
```bash
git add server/src/agent/abe/setupCategories.ts server/test/setupCategories.test.ts
git commit -m "feat(calls): setupCategories — Abe derives, applies (guarded), and tags categories"
```

---

## Task 2: `setup_categories` chat tool

**Files:** Modify `server/src/agent/abe/lineChatTools.ts`; Test `server/test/setupCategories.chatTool.test.ts`

- [ ] **Step 1: Failing test `server/test/setupCategories.chatTool.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { getLineReportConfig } from '../src/repos/lineReportConfigs.js';
import { makeLineChatProvider } from '../src/agent/abe/lineChatTools.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

const stub = { chat: async () => ({ content: JSON.stringify({ tags: [] }) }) };

it('setup_categories is advertised and applies a passed list', async () => {
  const t = await createTenant(pool);
  const p = makeLineChatProvider({ pool, tenantId: t.id, llm: stub as any, model: 'gpt-4o' });
  expect((await p.listTools()).map((x: { name: string }) => x.name)).toContain('setup_categories');
  const out = JSON.parse(await p.callTool('setup_categories', { categories: ['Claims', 'Policy'] }));
  expect(out.applied).toBe(true);
  expect(out.categories).toEqual(['Claims', 'Policy']);
  expect((await getLineReportConfig(pool, t.id))?.taxonomy).toEqual(['Claims', 'Policy']);
});

it('setup_categories returns a friendly error when no LLM is configured', async () => {
  const t = await createTenant(pool);
  const p = makeLineChatProvider({ pool, tenantId: t.id }); // no llm/model
  const out = JSON.parse(await p.callTool('setup_categories', { categories: ['X'] }));
  expect(out.error).toMatch(/openai/i);
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Edit `lineChatTools.ts`**
- Import: `import { setupCategories } from './setupCategories.js';`
- Add to the `TOOLS` array (match neighbours' shape):
```typescript
  {
    name: 'setup_categories',
    description: 'Analyse the calls and set up the call categories (taxonomy) yourself, then sort existing calls into them. Optionally pass a specific list, or set replace:true to overwrite the current set.',
    parameters: { type: 'object', properties: { categories: { type: 'array', items: { type: 'string' } }, replace: { type: 'boolean' } } },
  },
```
- Add the `case` in `callTool` (the provider exposes `pool`, `tenantId`, and optional `llm`/`model` in its closure — match how the file references them):
```typescript
    case 'setup_categories': {
      if (!llm || !model) return ok({ error: 'Connect an OpenAI key first.' });
      const a = args as { categories?: string[]; replace?: boolean };
      return ok(await setupCategories({ pool, tenantId, llm, model, categories: a.categories, replace: a.replace }));
    }
```
> Read the file to see exactly how `llm`/`model` are named/destructured in the provider closure and replicate that. If they're accessed as `ctx.llm`, use that form.

- [ ] **Step 4: Run → PASS.**  **Step 5: Run the structural-gate test (must stay green): `npx vitest run test/lineReport.chatTools.test.ts test/setupCategories.chatTool.test.ts` → PASS.**  **Step 6: `npm -w server run build` → PASS.**  **Step 7: Commit**
```bash
git add server/src/agent/abe/lineChatTools.ts server/test/setupCategories.chatTool.test.ts
git commit -m "feat(calls): setup_categories chat tool (safe-write, no send)"
```

---

## Task 3: Wire `llm`/`model` into the chat provider (if missing)

**Files:** Possibly modify the agent-chat handler (`server/src/agent/abe/chat.ts` / `runAbeChat`, or `routes/agentChat.ts`); Test: covered by Task 2 + a wiring assertion.

- [ ] **Step 1:** Find where `makeLineChatProvider(` is constructed for the live chat (grep `makeLineChatProvider(` under `server/src`). Read that call site.
- [ ] **Step 2:** If it already passes `llm` and `model`, this task is a no-op — record that and skip to commit-less completion (note it in your report). If it does NOT pass them, thread the tenant's `llm`/`model` (obtained the same way the handler builds the runner LLM — likely via `tenantLlm`/`getAgentOpenAIKey` already present in that handler) into the `makeLineChatProvider({ pool, tenantId, llm, model })` call so `setup_categories` (and any other LLM tool) works at runtime.
- [ ] **Step 3:** If you changed the handler, run its existing test (grep for the chat orchestrator test, e.g. `test/abe.chat.orchestrator.test.ts`) → PASS, and `npm -w server run build` → PASS.
- [ ] **Step 4: Commit (only if changed)**
```bash
git add -A && git commit -m "fix(abe-chat): pass tenant llm/model into the chat tool provider"
```

---

## Task 4: `POST /api/calls/setup-categories` route

**Files:** Modify `server/src/routes/callAnalytics.ts`; Test: extend `server/test/callAnalytics.routes.test.ts`

- [ ] **Step 1: Failing test** — add to `callAnalytics.routes.test.ts` (reuse its `adminSession`/`nonAdminSession`/`csrf`/`llmStub` harness):
```typescript
describe('POST /api/calls/setup-categories', () => {
  it('403 for non-admin', async () => {
    const { agent } = await nonAdminSession();
    const res = await agent.post('/api/calls/setup-categories').send({ categories: ['Claims'] });
    expect(res.status).toBe(403);
  });
  it('admin: applies a passed list + returns counts', async () => {
    const { agent, tenantId } = await adminSession();
    // (seed an inbound call if the harness needs one for tagging; mirror how import-past test seeds)
    const res = await agent.post('/api/calls/setup-categories').send({ categories: ['Claims', 'Policy'] });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    expect(res.body.categories).toEqual(['Claims', 'Policy']);
    expect(typeof res.body.tagged).toBe('number');
  });
});
```
> Match the exact request idiom the other tests in this file use (supertest `agent` + CSRF header, or `app.inject`). Copy from the existing `import-past`/`categories` route tests in the same file.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Add the route** in `callAnalytics.ts` next to `suggest-categories`/`import-past` (before any `/api/calls/:id`):
```typescript
  app.post('/api/calls/setup-categories', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const body = z.object({
        categories: z.array(z.string().min(1)).max(30).optional(),
        replace: z.boolean().optional(),
      }).parse(req.body ?? {});
      const { llm, model } = await tenantLlm(app, ctx.tenantId);
      const { setupCategories } = await import('../agent/abe/setupCategories.js');
      reply.send(await setupCategories({ pool: app.pool, tenantId: ctx.tenantId, llm, model, categories: body.categories, replace: body.replace }));
    } catch (e) { sendError(reply, e); }
  });
```
> If the other routes in this file import helpers at the top (not dynamic `import()`), match that and add a top-of-file `import { setupCategories } from '../agent/abe/setupCategories.js';` instead.

- [ ] **Step 4: Run → PASS.**  **Step 5: `npm -w server run build` → PASS.**  **Step 6: Commit**
```bash
git add server/src/routes/callAnalytics.ts server/test/callAnalytics.routes.test.ts
git commit -m "feat(calls): POST /api/calls/setup-categories (admin)"
```

---

## Task 5: Automatic — wire `ensureCategories` into import + cron

**Files:** Modify `server/src/agent/abe/backfillCalls.ts` and `server/src/agent/abe/lineShift.ts`; Test `server/test/setupCategories.auto.test.ts`

- [ ] **Step 1: Failing test `server/test/setupCategories.auto.test.ts`**
```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { getLineReportConfig } from '../src/repos/lineReportConfigs.js';
import { mirrorEmailAsCall } from '../src/agent/abe/mirrorCall.js';
import { backfillCallsFromEmails } from '../src/agent/abe/backfillCalls.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

const stub = (cats: string[]) => ({
  chat: async (a: { messages: Array<{ content: string }> }) => {
    const text = a.messages.map(m => m.content).join(' ').toLowerCase();
    if (text.includes('categor')) return { content: JSON.stringify({ categories: cats }) };
    return { content: JSON.stringify({ tags: [] }) };
  },
});

it('backfill auto-creates categories for an empty-taxonomy tenant', async () => {
  const t = await createTenant(pool);
  await mirrorEmailAsCall({ pool, tenantId: t.id, emailId: 'e1', summary: 'caller about a claim' });
  await backfillCallsFromEmails({ pool, tenantId: t.id, llm: stub(['Claims', 'Policy']) as any, model: 'gpt-4o' });
  expect((await getLineReportConfig(pool, t.id))?.taxonomy).toEqual(['Claims', 'Policy']);
});
```
> Adjust the stub branch token to match `suggestCategories`'s real prompt (same caveat as Task 1).

- [ ] **Step 2: Run → FAIL (taxonomy still empty).**

- [ ] **Step 3a:** In `backfillCalls.ts`, import `ensureCategories` and call it AFTER the import loop, BEFORE the existing `tagNewCalls` loop:
```typescript
  const { ensureCategories } = await import('./setupCategories.js'); // or top-of-file import
  await ensureCategories({ pool: args.pool, tenantId: args.tenantId, llm: args.llm, model: args.model });
```
(A top-of-file `import { ensureCategories } from './setupCategories.js';` is cleaner — match the file's style. Avoid a circular import: `setupCategories.ts` imports `tagNewCalls` from `lineTagger.js`, NOT from `backfillCalls.js`, so `backfillCalls.ts → setupCategories.ts` is acyclic.)

- [ ] **Step 3b:** In `lineShift.ts::runLineReportShift`, import `ensureCategories` and call it immediately BEFORE the `tagNewCalls({... batch:100})` line (~23):
```typescript
  await ensureCategories({ pool, tenantId, llm, model });
  const tagged = await tagNewCalls({ pool, tenantId, llm, model, batch: 100 });
```
> Confirm `llm`/`model` are in scope at that point in `runLineReportShift` (they're used on the next line, so they are). `ensureCategories` is a guarded no-op when a taxonomy already exists — no extra LLM cost on steady-state runs.

- [ ] **Step 4: Run the new test → PASS.**  **Step 5: Run the existing backfill + shift tests (`npx vitest run test/callIngestion.backfill.test.ts test/lineShift*.test.ts` — use the real shift test filename if present) → PASS (no regression).**  **Step 6: `npm -w server run build` → PASS.**  **Step 7: Commit**
```bash
git add server/src/agent/abe/backfillCalls.ts server/src/agent/abe/lineShift.ts server/test/setupCategories.auto.test.ts
git commit -m "feat(calls): auto-setup categories on import + cron (ensureCategories guard)"
```

---

## Task 6: UI — "Let Abe set them up for me" button

**Files:** Modify `web/src/lib/calls.ts`, `web/src/pages/Calls.tsx`; verify with web build.

- [ ] **Step 1: Web client** — add to `web/src/lib/calls.ts` (match the existing `api<T>(path, opts)` idiom):
```typescript
export const autoSetupCategories = (opts?: { categories?: string[]; replace?: boolean }) =>
  api<{ categories: string[]; tagged: number; applied: boolean }>(`/api/calls/setup-categories`, {
    method: 'POST', body: JSON.stringify(opts ?? {}),
  });
```

- [ ] **Step 2: `Calls.tsx` `FirstRunCard`** — make Abe-does-it-all the PRIMARY path (cover all states):
  - Add a primary button **"Let Abe set them up for me"**. On click: disable + show a spinner/label ("Abe is reading your calls…"), call `autoSetupCategories()`.
    - On success with `applied === true`: `onSaved(res.categories)` and `toast.success('Abe set up ' + res.categories.length + ' categories and sorted ' + res.tagged + ' calls.')`.
    - On success with `applied === false` (e.g. no calls yet to learn from): `toast.error('Abe needs some calls first — import past calls, then try again.')` and stay on the card.
    - On failure: `toast.error(friendlyError(e))`, re-enable the button (don't lose the manual flow).
  - Keep the EXISTING manual suggest→edit→save flow visible as the secondary option, relabelled e.g. **"I'll set them up myself"**.
  - Reuse `Button`, `Spinner`, `useToast`, `friendlyError` already imported in the page; match spacing (8px grid) and the existing card styling.

- [ ] **Step 3:** `cd web && npm run build && npx tsc --noEmit` → success (no NEW errors in `Calls.tsx`/`calls.ts`).

- [ ] **Step 4: Commit**
```bash
git add web/src/lib/calls.ts web/src/pages/Calls.tsx
git commit -m "feat(calls): one-click 'Let Abe set up categories' on the Calls first-run"
```

---

## Final verification

- [ ] **Suite:** `cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/setupCategories.test.ts test/setupCategories.chatTool.test.ts test/setupCategories.auto.test.ts test/callAnalytics.routes.test.ts test/lineReport.chatTools.test.ts test/callIngestion.backfill.test.ts` → all PASS.
- [ ] **No regressions:** run the abe-chat orchestrator + any shift test → PASS.
- [ ] **Builds:** `npm -w server run build` AND `cd web && npm run build` → both succeed.
- [ ] **Post-deploy manual (prod):** on MPS (calls present, no categories) → open Calls → "Let Abe set them up for me" → categories appear + breakdown populates. In Abe chat: "Abe, set up my call categories" works. Re-running doesn't overwrite a curated taxonomy.

---

## Self-review (author)

- **Spec coverage:** `applyCategories`/`setupCategories`/`ensureCategories` → Task 1; chat tool → Task 2 (+ provider wiring → Task 3); button+route → Task 4 + Task 6; automatic → Task 5. Safety (guard/no-clobber, no send, admin gate, bounds) baked into Task 1 + Task 4.
- **Placeholder scan:** none — every code step has concrete code; stub-token caveat is a verify-instruction, not a placeholder.
- **Type consistency:** `applyCategories(pool,tenantId,categories,opts?)`, `setupCategories({pool,tenantId,llm,model,categories?,replace?})`, `ensureCategories({pool,tenantId,llm,model})`, web `autoSetupCategories(opts?)`, route returns `{categories,tagged,applied}` — used identically across tasks.
- **Circular-import check:** `setupCategories.ts` depends on `categorySuggest`,`lineTagger`,`lineReportConfigs` only; `backfillCalls.ts`/`lineShift.ts` depend on `setupCategories.ts` — acyclic.
- **Build gotcha:** run `npm -w server run build` before push; confirm the stub `chat` shape + the provider's `llm`/`model` access form by reading the real files.
