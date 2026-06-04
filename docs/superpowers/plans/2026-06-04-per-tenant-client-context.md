# Per-Tenant Client Context (de-ABSA) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded "ABSA"/"bank client" with a per-tenant client profile (`client_name` + `client_context`), with generic fallbacks, and stop seeding ABSA-banking default categories for new tenants.

**Architecture:** New `client_name`/`client_context` on `line_report_configs`; a `clientContext.ts` helper (`clientLabel`, `clientPromptBlock`) with generic fallbacks; threaded through every prompt-builder (each already loads the config), the chat system prompt, the handover subject, and the web UI. First Assist's profile is set to ABSA at deploy.

**Tech Stack:** TypeScript, Fastify, `pg`, node-pg-migrate, Vitest (serial, Neon test branch), React. Spec: `docs/superpowers/specs/2026-06-04-per-tenant-client-context-design.md`.

**Verified surfaces (from code, file:line):** every builder loads `getLineReportConfig(pool, tenantId)` in scope — `lineCompose.ts` (composeDigest@126, composeAlert@175, composeCase@204, composeAnswer@232; system array @74-79; ABSA @12,158,188,215,235), `lineTagger.ts` (cfg@12, "bank client"@21), `handoverExtract.ts` (cfg@12, ABSA@21, dismissReason@75), `handoverSend.ts` (cfg@52, subject@19). `lineChatTools.ts` static descriptions @25,40. `chat.ts` builds system @30 via `buildAbeSystemPrompt(goal?.brand_voice)`; `prompt.ts::buildAbeSystemPrompt(brandVoice)`@15. `lineReportConfigs.ts`: `LineReportConfigRow`@3-18, `LineReportConfigPatch`@21-33, upsert COALESCE pattern (brand_voice is `$13`, nullable). Web: `lib/abe.ts` `LineReportConfig`@41-52 + `getLineSettings`/`putLineSettings`; `LineReportingSettings.tsx` form@26-37 + PUT@126-149; `AbeHome.tsx`@14,42,60-61; `AbeChat.tsx`@142. `routes/lineReports.ts` `SettingsBody`@30-40. Last migration `028` → yours is `029`.

**Environment (every task):** repo root `C:\Users\liamp\Desktop\tools\Aiployee emailer`; branch `feature/per-tenant-client-context`. One test: `cd "/c/Users/liamp/Desktop/tools/Aiployee emailer/server" && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/<file>`. Migrate test branch: `cd "/c/Users/liamp/Desktop/tools/Aiployee emailer" && DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server run migrate`. **Before pushing: `npm -w server run build`** (strict tsc). Web: `cd web && npm run build && npx tsc --noEmit` (pre-existing Domains/Segments errors OK). LSP-first: `mcp__ide__getDiagnostics()` once before the first `.ts`/`.tsx` Read, then Read scoped offset+limit. Helpers: `makePool`,`truncateAll`,`createTenant`; `seedInboundCall` (`test/helpers/lineReport.js`).

---

## Task 1: Migration 029 + repo `client_name`/`client_context`

**Files:** Create `server/migrations/1700000000029_client_profile.cjs`; modify `server/src/repos/lineReportConfigs.ts`; Test `server/test/clientProfile.config.test.ts`

- [ ] **Step 1: Migration** `server/migrations/1700000000029_client_profile.cjs`
```javascript
/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.addColumn('line_report_configs', {
    client_name: { type: 'text' },
    client_context: { type: 'text' },
  });
};
exports.down = (pgm) => {
  pgm.dropColumn('line_report_configs', 'client_name');
  pgm.dropColumn('line_report_configs', 'client_context');
};
```
Apply: `cd "/c/Users/liamp/Desktop/tools/Aiployee emailer" && DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server run migrate`. Confirm `029`.

- [ ] **Step 2: Failing test** `server/test/clientProfile.config.test.ts`
```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { getLineReportConfig, upsertLineReportConfig } from '../src/repos/lineReportConfigs.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

it('client_name/client_context round-trip and default null', async () => {
  const t = await createTenant(pool);
  const c1 = await upsertLineReportConfig(pool, t.id, { enabled: true });
  expect(c1.client_name).toBeNull();
  expect(c1.client_context).toBeNull();
  const c2 = await upsertLineReportConfig(pool, t.id, { clientName: 'ABSA', clientContext: 'iDirect overflow line' });
  expect(c2.client_name).toBe('ABSA');
  expect(c2.client_context).toBe('iDirect overflow line');
  // unrelated patch preserves them (mirror brand_voice semantics)
  const c3 = await upsertLineReportConfig(pool, t.id, { enabled: false });
  expect(c3.client_name).toBe('ABSA');
  expect((await getLineReportConfig(pool, t.id))?.client_context).toBe('iDirect overflow line');
});
```
> Verify the brand_voice handling first: if brand_voice does NOT preserve on an unrelated patch (i.e. it's `$n` direct, not COALESCE), then mirror THAT semantics and adjust the c3 assertion accordingly. The requirement: client fields behave **exactly like brand_voice**. Read the upsert to confirm and make the test match brand_voice's real behavior.

- [ ] **Step 3: Run → FAIL.**

- [ ] **Step 4: Edit `lineReportConfigs.ts`:** add `client_name: string | null;` + `client_context: string | null;` to `LineReportConfigRow`; `clientName?: string | null;` + `clientContext?: string | null;` to `LineReportConfigPatch`; add both to the upsert INSERT columns/placeholders + UPDATE set + params array, **mirroring the `brand_voice` placeholder exactly** (same COALESCE-or-direct form brand_voice uses). Add the params (`patch.clientName ?? null`, `patch.clientContext ?? null`). `RETURNING *`/`SELECT *` already cover the new columns.

- [ ] **Step 5: Run → PASS.** **Step 6:** `npm -w server run build` → PASS. **Step 7: Commit**
```bash
git add server/migrations/1700000000029_client_profile.cjs server/src/repos/lineReportConfigs.ts server/test/clientProfile.config.test.ts
git commit -m "feat(abe): client_name/client_context on line_report_configs"
```

---

## Task 2: `clientContext.ts` helper

**Files:** Create `server/src/agent/abe/clientContext.ts`; Test `server/test/clientContext.helper.test.ts`

- [ ] **Step 1: Failing test** `server/test/clientContext.helper.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { clientLabel, clientPromptBlock } from '../src/agent/abe/clientContext.js';

it('clientLabel falls back to a generic label', () => {
  expect(clientLabel({ client_name: 'ABSA' })).toBe('ABSA');
  expect(clientLabel({ client_name: '  ' })).toBe('the client');
  expect(clientLabel(null)).toBe('the client');
});

it('clientPromptBlock includes name + context, or empty when unset', () => {
  expect(clientPromptBlock({ client_name: 'ABSA', client_context: 'iDirect overflow' }))
    .toBe('You are reporting to ABSA. About this line: iDirect overflow');
  expect(clientPromptBlock({ client_name: 'ABSA' })).toBe('You are reporting to ABSA.');
  expect(clientPromptBlock(null)).toBe('');
  expect(clientPromptBlock({ client_name: null, client_context: null })).toBe('');
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `server/src/agent/abe/clientContext.ts` (exactly the spec's helper):
```typescript
export function clientLabel(cfg: { client_name?: string | null } | null | undefined): string {
  return cfg?.client_name?.trim() || 'the client';
}
export function clientPromptBlock(
  cfg: { client_name?: string | null; client_context?: string | null } | null | undefined,
): string {
  const name = cfg?.client_name?.trim();
  const ctx = cfg?.client_context?.trim();
  if (!name && !ctx) return '';
  const who = name ? `You are reporting to ${name}.` : 'You are reporting to the client who runs this line.';
  return ctx ? `${who} About this line: ${ctx}` : who;
}
```

- [ ] **Step 4: Run → PASS.** **Step 5:** `npm -w server run build` → PASS. **Step 6: Commit**
```bash
git add server/src/agent/abe/clientContext.ts server/test/clientContext.helper.test.ts
git commit -m "feat(abe): clientContext helper (label + prompt block, generic fallbacks)"
```

---

## Task 3: Genericize every server prompt + the chat system prompt

**Files:** Modify `server/src/agent/abe/lineCompose.ts`, `lineTagger.ts`, `handoverExtract.ts`, `handoverSend.ts`, `lineChatTools.ts`, `prompt.ts`, `chat.ts`; Test `server/test/clientContext.prompts.test.ts`

- [ ] **Step 1: Failing test** `server/test/clientContext.prompts.test.ts` — prove (a) no "ABSA"/"bank" leaks when unconfigured, (b) the client name appears when set. Use a message-capturing stub LLM.
```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { seedInboundCall } from './helpers/lineReport.js';
import { upsertLineReportConfig } from '../src/repos/lineReportConfigs.js';
import { tagNewCalls } from '../src/agent/abe/lineTagger.js';
import { buildAbeSystemPrompt } from '../src/agent/abe/prompt.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

// captures the system prompt the builder sends
function capStub(reply: object) {
  const seen: string[] = [];
  return { seen, llm: { chat: async (a: { messages: Array<{ role: string; content: string }> }) => { seen.push(a.messages.map(m => m.content).join('\n')); return { content: JSON.stringify(reply) }; } } };
}

it('tagger prompt is de-banked (no "bank client")', async () => {
  const t = await createTenant(pool);
  await upsertLineReportConfig(pool, t.id, { enabled: true, taxonomy: ['Claims'] });
  await seedInboundCall(pool, t.id, 'a claim');
  const s = capStub({ tags: [] });
  await tagNewCalls({ pool, tenantId: t.id, llm: s.llm as any, model: 'gpt-4o', batch: 10 });
  expect(s.seen.join(' ')).not.toMatch(/bank client/i);
});

it('buildAbeSystemPrompt injects the client when set, generic otherwise', () => {
  expect(buildAbeSystemPrompt('', 'ABSA', 'iDirect overflow')).toContain('ABSA');
  expect(buildAbeSystemPrompt('', 'ABSA', 'iDirect overflow')).toContain('iDirect overflow');
  const generic = buildAbeSystemPrompt('');
  expect(generic).not.toContain('ABSA');
});
```
> You may add more assertions (e.g. capture composeDigest's messages with `client_name='ABSA'` and assert it contains 'ABSA'; with none, contains 'the client' and not 'ABSA'). Keep at least the two above. Read each builder to wire the capture correctly.

- [ ] **Step 2: Run → FAIL** (buildAbeSystemPrompt doesn't take client args yet; tagger still says "bank client").

- [ ] **Step 3: Edits** (import `clientLabel`/`clientPromptBlock` from `./clientContext.js` where needed; each builder already has `cfg` from `getLineReportConfig`):
  - **`prompt.ts`**: change signature to `buildAbeSystemPrompt(brandVoice: string | null | undefined, clientName?: string | null, clientContext?: string | null): string`. Build the result as `ABE_SYSTEM` + (brandVoice line if set) + (a client line if `clientName?.trim()` or `clientContext?.trim()` — reuse the same phrasing as `clientPromptBlock`, e.g. import and call it: `clientPromptBlock({ client_name: clientName, client_context: clientContext })`, append when non-empty). Keep existing callers working (extra args optional).
  - **`chat.ts`** (line ~30): load `const cfg = await getLineReportConfig(pool, tenantId);` (import if needed) and pass `buildAbeSystemPrompt(goal?.brand_voice ?? null, cfg?.client_name, cfg?.client_context)`.
  - **`lineTagger.ts`** line 21: `'You are Abe, classifying inbound CALL SUMMARIES for the client\'s call-line report.'` (drop "bank client").
  - **`handoverExtract.ts`** line 21: `` `You are Abe, preparing CALLBACK HANDOVERS for ${clientLabel(cfg)} from overflow call summaries.` ``; line 75 dismissReason → `'Resolved on call (no follow-up needed).'`.
  - **`handoverSend.ts`** line 19: `` const subject = `Callback for ${clientLabel(cfg)} — ${h.caller_name ?? 'caller'} · ${h.reason_category}${h.urgency === 'high' ? ' · URGENT' : ''}`; ``.
  - **`lineCompose.ts`**: line 12 ADVISORY_INSTRUCTIONS → "...PR advisor for the client." (drop "(ABSA)"). Thread `clientName`/`clientContext` from each compose fn's `cfg` into `runCompose` (add params), and add `clientPromptBlock({client_name: clientName, client_context: clientContext})` (when non-empty) as an element of the `system` array (74-79). Context labels: 158 → `` `Write the ${periodLabel} ${clientLabel(cfg)} call-line update.` ``; 188 → `` `Write a brief spike heads-up for ${clientLabel(cfg)} about ${s.category}.` ``; 215 → `` `Escalate this individual call to ${clientLabel(cfg)} with recommended handling and a drafted response.` ``; 235 → `` `Question from ${clientLabel(cfg)}: ${args.question}...` ``. (Each compose fn has `cfg` in scope; pass it or its fields to `runCompose`/the label.)
  - **`lineChatTools.ts`** lines 25/40: "Recent ABSA reports with type/status." → "Recent client reports with type/status."; "Draft an ABSA report (digest/answer)..." → "Draft a client report (digest/answer). Creates a pending_approval draft; never sends."

- [ ] **Step 4: Run the new test → PASS.** **Step 5:** Run the existing line-report/handover/chat tests to catch regressions: `npx vitest run test/lineReport.compose.test.ts test/handover.routes.test.ts test/abe.chat.orchestrator.test.ts test/lineReport.tagger.test.ts` → PASS (NOTE: some may fail due to the taxonomy-default change — that's Task 4; if a failure is ONLY about a missing default taxonomy, leave it for Task 4 and note it; any failure about ABSA wording must be fixed here). **Step 6:** `npm -w server run build` → PASS. **Step 7: Commit**
```bash
git add server/src/agent/abe/lineCompose.ts server/src/agent/abe/lineTagger.ts server/src/agent/abe/handoverExtract.ts server/src/agent/abe/handoverSend.ts server/src/agent/abe/lineChatTools.ts server/src/agent/abe/prompt.ts server/src/agent/abe/chat.ts server/test/clientContext.prompts.test.ts
git commit -m "feat(abe): thread per-tenant client context through prompts (de-ABSA, generic fallbacks)"
```
> If the existing `lineReport.chatTools.test.ts` asserts the old "ABSA report" description text, update that assertion to the new generic text in this task.

---

## Task 4: Stop seeding ABSA-banking default categories

**Files:** Modify `server/src/repos/lineReportConfigs.ts`; fix reliant tests; Test `server/test/clientProfile.taxonomyDefault.test.ts`

- [ ] **Step 1: Failing test** `server/test/clientProfile.taxonomyDefault.test.ts`
```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { upsertLineReportConfig } from '../src/repos/lineReportConfigs.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

it('a new config has NO default categories (empty taxonomy)', async () => {
  const t = await createTenant(pool);
  const c = await upsertLineReportConfig(pool, t.id, { enabled: true });
  expect(c.taxonomy).toEqual([]);
});
```

- [ ] **Step 2: Run → FAIL** (currently seeds the 8 ABSA categories).

- [ ] **Step 3:** In `lineReportConfigs.ts`, change the taxonomy INSERT default from `DEFAULT_TAXONOMY` to an empty array. The upsert currently does `COALESCE($8, $9::jsonb)` where `$9 = DEFAULT_TAXONOMY`; change the default to `'[]'::jsonb` (either replace the `$9` param value with `'[]'` JSON string, or change the SQL default to `'[]'::jsonb`). Keep the `DEFAULT_TAXONOMY` constant if other code references it (grep — if nothing else uses it, you may remove it; if unsure, leave it unused with a comment). Do NOT change existing rows.

- [ ] **Step 4: Run the new test → PASS.**

- [ ] **Step 5: Fix the reliant tests.** Run `npx vitest run test/lineReport.tagger.test.ts test/lineReport.shift.test.ts test/lineReport.compose.test.ts` (and any other that creates a config with `{ enabled: true }` and then expects the 8 default categories to exist). Each failing test that relied on the seeded default must now pass an explicit `taxonomy` to `upsertLineReportConfig` (e.g. `{ enabled: true, taxonomy: ['Card disputes / fraud', 'Online & app banking'] }`) so the tagger has categories. Grep `server/test` for `upsertLineReportConfig(.*enabled: true` and check each; add explicit taxonomy where the test depends on categories existing. Re-run until green.

- [ ] **Step 6:** Full suite spot-check: `npx vitest run test/lineReport.*.test.ts test/handover.*.test.ts test/callIngestion.*.test.ts test/setupCategories*.test.ts` → all PASS. **Step 7:** `npm -w server run build` → PASS. **Step 8: Commit**
```bash
git add server/src/repos/lineReportConfigs.ts server/test/
git commit -m "feat(abe): new tenants start with no default categories (Abe derives them)"
```

---

## Task 5: API settings + web UI

**Files:** Modify `server/src/routes/lineReports.ts`, `web/src/lib/abe.ts`, `web/src/components/abe/LineReportingSettings.tsx`, `web/src/components/abe/AbeHome.tsx`, `web/src/components/abe/AbeChat.tsx`; Test: extend the line-report settings route test.

- [ ] **Step 1: Route zod** — in `server/src/routes/lineReports.ts` `SettingsBody` (~30-40), add:
```typescript
  clientName: z.string().max(200).trim().nullable().optional(),
  clientContext: z.string().max(2000).trim().nullable().optional(),
```
GET/PUT already load/pass the full config (the new row fields flow out via `getLineReportConfig`; PUT passes the patch through to `upsertLineReportConfig`). If the PUT handler maps body→patch explicitly (not a spread), add `clientName`/`clientContext` to that mapping.

- [ ] **Step 2: Route test** — extend the existing line-report settings route test (grep `test/lineReport.routes.test.ts` for the settings PUT/GET test): PUT `{ clientName: 'ABSA', clientContext: 'iDirect overflow' }` then GET returns them on `config`. Reuse the file's admin-session harness. Run → PASS. `npm -w server run build` → PASS.

- [ ] **Step 3: Web client** — `web/src/lib/abe.ts`: add `client_name: string | null;` + `client_context: string | null;` to the `LineReportConfig` interface; ensure `putLineSettings`'s body type accepts `clientName?`/`clientContext?` (match how it sends other fields).

- [ ] **Step 4: Settings form** — `LineReportingSettings.tsx`: add to `FormState` `clientName: string; clientContext: string;`; initialise from the loaded config (`config.client_name ?? ''`, `config.client_context ?? ''`); add a **"Client name"** text input and a **"Client / line context"** textarea (hint: *"A short note on who you report to and what this line is — Abe uses it to tailor his analysis and drafts."*); include `clientName: form.clientName.trim() || null, clientContext: form.clientContext.trim() || null` in the `putLineSettings({...})` call (~126-149). Match existing field styling/8px grid.

- [ ] **Step 5: Copy** — replace literal "ABSA" with the client name (fallback "your client") using the config from `getLineSettings()`:
  - `AbeHome.tsx` line 14: `'Needs setup before he can send to ' + (clientName || 'your client')` (read how the component gets config; it calls `getLineSettings()` — derive `const clientName = config?.client_name?.trim()`).
  - `AbeHome.tsx` lines 60-61: "writes to your client (ABSA)" → `writes to ${clientName || 'your client'}`.
  - `AbeChat.tsx` line 142: "draft an update for ABSA" → `draft an update for ${clientName || 'your client'}` (this component also calls `getLineSettings()` / receives config — wire the name in; if it doesn't currently load config, read the nearest provider/prop and pass the name or default to 'your client').
  - If a component doesn't already have the config, the simplest correct fallback is the literal "your client" — do NOT introduce a heavy new fetch just for copy; use config if already present, else "your client".

- [ ] **Step 6:** `cd web && npm run build && npx tsc --noEmit` → success (no NEW errors in touched files). **Step 7: Commit**
```bash
git add server/src/routes/lineReports.ts web/src/lib/abe.ts web/src/components/abe/LineReportingSettings.tsx web/src/components/abe/AbeHome.tsx web/src/components/abe/AbeChat.tsx server/test/
git commit -m "feat(abe): client profile settings UI + de-ABSA copy (client name with fallback)"
```

---

## Final verification

- [ ] **Suite:** `cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/clientProfile.config.test.ts test/clientContext.helper.test.ts test/clientContext.prompts.test.ts test/clientProfile.taxonomyDefault.test.ts test/lineReport.routes.test.ts test/lineReport.tagger.test.ts test/lineReport.shift.test.ts test/lineReport.compose.test.ts test/handover.routes.test.ts test/abe.chat.orchestrator.test.ts test/abe.chat.safety.test.ts` → all PASS.
- [ ] **Builds:** `npm -w server run build` AND `cd web && npm run build` → both succeed.
- [ ] **Post-deploy:** (a) migration 029 on prod; (b) set First Assist `client_name='ABSA'` + a `client_context` (authorized data write); (c) verify a NON-First-Assist tenant's Abe/handover/report says "the client"/"your client", never "ABSA"; First Assist still says "ABSA".

---

## Self-review (author)

- **Spec coverage:** schema+repo → Task 1; helper → Task 2; all prompts + chat → Task 3; categories default → Task 4; API+web+copy → Task 5. First Assist data set at deploy.
- **Order keeps the suite green:** client fields (T1) and helper (T2) are additive; T3 genericizes prompts (tests assert generic + ABSA-when-set); T4 changes the taxonomy default and fixes the reliant tests in the SAME commit; T5 is API/UI. (T3 Step 5 explicitly defers taxonomy-only failures to T4.)
- **Placeholder scan:** none — concrete code/edits per step; "read the file to wire X" are verify-instructions.
- **Type consistency:** `client_name`/`client_context` (row, snake) vs `clientName`/`clientContext` (patch/API, camel); `clientLabel(cfg)`/`clientPromptBlock(cfg)`; `buildAbeSystemPrompt(brandVoice, clientName?, clientContext?)` — consistent across tasks.
- **Risk:** the taxonomy-default change (T4) breaks tests that lean on the seeded default — T4 Step 5 finds and fixes them explicitly. Confirm `brand_voice` upsert semantics before mirroring (T1 Step 2).
