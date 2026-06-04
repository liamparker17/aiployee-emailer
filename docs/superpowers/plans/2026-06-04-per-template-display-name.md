# Per-Template From Display Name — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a template set its own From display name; when a send uses that template, its name wins, with the sender's `display_name` as the fallback. Resolve-and-lock the name onto the email row at queue time.

**Architecture:** `templates.display_name` (the override) + `emails.from_display_name` (the resolved value per send). `pipeline.queueEmail` computes `from_display_name` from the resolved template and stores it; `dispatch.sendOne` uses `email.from_display_name ?? sender.display_name`. Backward compatible: null ⇒ sender's name, exactly as today.

**Tech Stack:** TypeScript, Fastify, `pg`, node-pg-migrate, Vitest (serial, Neon test branch), nodemailer + smtp-tester, React. Spec: `docs/superpowers/specs/2026-06-04-per-template-display-name-design.md`.

**Verified surfaces (from code):**
- `dispatch.ts:47` (in `sendOne`): `from: { name: sender.display_name, address: sender.email }`. `sendOne` has the `EmailRow` + the looked-up `sender`.
- `pipeline.ts::queueEmail` (~40-90): looks up `sender` (`getSenderByEmail`), resolves template via `getTemplateByName(pool, tenantId, input.template)` (~55), renders subject/body, calls `insertEmail(...)` with `templateId`.
- `repos/templates.ts`: `Template` row type; `createTemplate({tenantId,name,subject,bodyHtml,bodyText?})`; `updateTemplate(id,{name?,subject?,bodyHtml?,bodyText?})`.
- `routes/templates.ts`: `CreateBody`/`UpdateBody` zod; `POST /api/templates`, `PATCH /api/templates/:id`.
- `repos/emails.ts`: `EmailRow` (has `template_id`, no `from_display_name`); `insertEmail(...)`.
- `web/src/pages/Templates.tsx`: `Tpl` type (line ~12); editor form (~69-77); create body (~40); PATCH body (~107-109). Uses `api()` from `web/src/api.ts`.

**Environment (every task):** repo root `C:\Users\liamp\Desktop\tools\Aiployee emailer`; branch `feature/per-template-display-name`. One test file: `cd "/c/Users/liamp/Desktop/tools/Aiployee emailer/server" && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/<file>`. Migrate test branch: `cd "/c/Users/liamp/Desktop/tools/Aiployee emailer" && DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server run migrate`. **Before pushing: `npm -w server run build`** (strict tsc). Web: `cd web && npm run build && npx tsc --noEmit` (pre-existing Domains/Segments errors OK). LSP-first: `mcp__ide__getDiagnostics()` once before the first `.ts`/`.tsx` Read, then Read scoped (offset+limit). Test helpers: `makePool`,`truncateAll` (`test/helpers/db.ts`), `createTenant` (`test/helpers/factories.ts`, `{id,name,slug}`); for send tests, mirror `test/v1Emails.test.ts` (it stands up app + API key + `startTestSmtp`).

---

## Task 1: Migration 028 + templates repo + routes (`display_name`)

**Files:** Create `server/migrations/1700000000028_template_display_name.cjs`; modify `server/src/repos/templates.ts`, `server/src/routes/templates.ts`; Test `server/test/templates.displayName.test.ts`

- [ ] **Step 1: Migration** `server/migrations/1700000000028_template_display_name.cjs`
```javascript
/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.addColumn('templates', { display_name: { type: 'text' } });
  pgm.addColumn('emails', { from_display_name: { type: 'text' } });
};
exports.down = (pgm) => {
  pgm.dropColumn('templates', 'display_name');
  pgm.dropColumn('emails', 'from_display_name');
};
```
Apply to the test DB: `cd "/c/Users/liamp/Desktop/tools/Aiployee emailer" && DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npm -w server run migrate`. Confirm `028` applied.

- [ ] **Step 2: Failing test** `server/test/templates.displayName.test.ts`
```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createTemplate, updateTemplate, getTemplateByName } from '../src/repos/templates.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

it('template display_name round-trips: set, preserve, clear', async () => {
  const t = await createTenant(pool);
  const c = await createTemplate(pool, { tenantId: t.id, name: 'absa_line', subject: 'S', bodyHtml: '<p>x</p>', displayName: '  First Assist Absa Line  ' });
  expect(c.display_name).toBe('First Assist Absa Line'); // trimmed
  // omitting displayName on update preserves it
  const u1 = await updateTemplate(pool, c.id, { subject: 'S2' });
  expect(u1.display_name).toBe('First Assist Absa Line');
  // explicit null clears it
  const u2 = await updateTemplate(pool, c.id, { displayName: null });
  expect(u2.display_name).toBeNull();
  expect((await getTemplateByName(pool, t.id, 'absa_line'))?.display_name).toBeNull();
});
```
> Verify the real signatures of `createTemplate`/`updateTemplate`/`getTemplateByName` first (the Explore says `createTemplate(pool, {tenantId,name,subject,bodyHtml,bodyText?})`). If the repo functions take `(pool, input)` vs `(input)` or return a different shape, adapt the test to the real signatures. The behaviors to prove: set+trim, omit-preserves, null-clears.

- [ ] **Step 3: Run → FAIL** (display_name not on the type / not written).

- [ ] **Step 4: Extend `server/src/repos/templates.ts`:**
  - Add `display_name: string | null;` to the `Template` row type.
  - `createTemplate` input: add `displayName?: string | null`. In the INSERT, add the `display_name` column + a param `input.displayName?.trim() || null`. Ensure RETURNING/SELECT covers it (if it uses `RETURNING *` / `SELECT *`, fine; else add the column).
  - `updateTemplate` input: add `displayName?: string | null`. The function builds a partial UPDATE — add `display_name` to the set when the key is PRESENT in the input (so `undefined` = preserve, `null` = clear). For the value, `input.displayName === undefined ? skip : (input.displayName?.trim() || null)`. Match the file's existing partial-update idiom (e.g. it may push `field = $n` only for provided keys — follow that exactly so omit-preserves works).

- [ ] **Step 5: Extend `server/src/routes/templates.ts`:**
  - `CreateBody`: add `displayName: z.string().max(120).trim().nullable().optional()`.
  - `UpdateBody`: add `displayName: z.string().max(120).trim().nullable().optional()`.
  - Pass `displayName` through to `createTemplate`/`updateTemplate` in the handlers (spread or explicit).

- [ ] **Step 6: Run the repo test → PASS.** Add a tiny route assertion if the file has a templates route test (grep `test/` for templates route tests); if one exists, extend it to POST with `displayName` and assert it returns; if none exists, the repo test + build is sufficient — note that.

- [ ] **Step 7:** `npm -w server run build` → PASS. **Step 8: Commit**
```bash
git add server/migrations/1700000000028_template_display_name.cjs server/src/repos/templates.ts server/src/routes/templates.ts server/test/templates.displayName.test.ts
git commit -m "feat(templates): per-template display_name (migration + repo + routes)"
```

---

## Task 2: `emails.from_display_name` on the row + insert

**Files:** Modify `server/src/repos/emails.ts`; Test: extend `server/test/templates.displayName.test.ts` or a small repo test.

- [ ] **Step 1: Failing test** — add to a server test (e.g. `server/test/emails.fromDisplayName.test.ts`):
```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { insertEmail } from '../src/repos/emails.js';
// reuse the sender/smtp seeding used by other tests (createSmtpConfig + createSender) — read test/callIngestion.backfill.test.ts for the pattern.

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

it('insertEmail persists from_display_name (and defaults null)', async () => {
  const t = await createTenant(pool);
  // create a sender (reuse the helper/seed used elsewhere) → senderId
  // const senderId = ...
  const withName = await insertEmail(pool, { tenantId: t.id, senderId, toAddr: 'c@x.com', subject: 'S', bodyHtml: '<p>x</p>', bodyText: null, status: 'queued', fromDisplayName: 'Absa Line' /* + whatever other required insertEmail fields */ });
  expect(withName.from_display_name).toBe('Absa Line');
  const without = await insertEmail(pool, { tenantId: t.id, senderId, toAddr: 'c@x.com', subject: 'S', bodyHtml: '<p>x</p>', bodyText: null, status: 'queued' });
  expect(without.from_display_name).toBeNull();
});
```
> READ `repos/emails.ts` `insertEmail` first to get its EXACT input shape (required fields, naming). The test above is illustrative — match the real `insertEmail` signature, supplying all required fields it needs. Reuse the sender seeding from `test/callIngestion.backfill.test.ts` (createSmtpConfig + createSender). If `insertEmail` is heavily parameterised, keep the test minimal but real.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Modify `server/src/repos/emails.ts`:**
  - Add `from_display_name: string | null;` to `EmailRow`.
  - `insertEmail` input: add `fromDisplayName?: string | null`. Add `from_display_name` to the INSERT column list + a param `input.fromDisplayName ?? null`. Ensure the function's RETURNING/SELECT includes it (if `RETURNING *`, fine).
  - If there are other SELECTs building `EmailRow` (e.g. `getEmailById`, `listEmails`, the dispatch fetch), confirm they `SELECT *` or add `from_display_name` so the field is populated when dispatch reads the row.

- [ ] **Step 4: Run → PASS.** **Step 5:** `npm -w server run build` → PASS. **Step 6: Commit**
```bash
git add server/src/repos/emails.ts server/test/emails.fromDisplayName.test.ts
git commit -m "feat(emails): carry from_display_name on the email row"
```

---

## Task 3: Resolve at queue, apply at dispatch

**Files:** Modify `server/src/send/pipeline.ts`, `server/src/send/dispatch.ts`; Test `server/test/templateDisplayName.send.test.ts`

- [ ] **Step 1: Failing test** `server/test/templateDisplayName.send.test.ts` — mirror `test/v1Emails.test.ts`'s app + API-key + `startTestSmtp` setup. Send via `/v1/emails` using a template that has a `display_name`, and assert the captured SMTP message's From shows the template name; then send a raw message (no template) and assert the From shows the sender's name.
```typescript
// Pseudostructure — fill in from v1Emails.test.ts's real harness:
// 1. build app, start test smtp, create tenant + smtp config + sender (display_name 'Sender Co') + api key
// 2. createTemplate(pool, { tenantId, name:'absa', subject:'Hi', bodyHtml:'<p>{{x}}</p>', displayName:'Absa Line' })
// 3. POST /v1/emails { template:'absa', to, variables:{x:'1'} }  → process queue → capture mail
//    expect(mail.from.text or headers.from).toContain('Absa Line')
// 4. POST /v1/emails { subject:'Raw', html:'<p>hi</p>', to } → capture
//    expect From contains 'Sender Co' (the sender display_name), NOT 'Absa Line'
```
> Read `test/v1Emails.test.ts` to copy the exact harness (how it builds the app, drains/processes the queue so dispatch runs, and how smtp-tester exposes the From header — `mail.from`, `mail.headers.from`, or address objects). Use `createTemplate` from the repo to set the display name. The two assertions (template-name wins; raw falls back to sender) are the contract.

- [ ] **Step 2: Run → FAIL** (From still shows sender for the template send).

- [ ] **Step 3: `server/src/send/pipeline.ts` (`queueEmail`):** where the template is resolved (`tpl = await getTemplateByName(...)`), compute `const fromDisplayName = tpl?.display_name?.trim() || null;` and pass `fromDisplayName` into the `insertEmail({...})` call. For non-template sends, pass `null` (or omit — `insertEmail` defaults null). Do not change subject/body rendering.

- [ ] **Step 4: `server/src/send/dispatch.ts` (`sendOne`, line ~47):** change
```typescript
  from: { name: sender.display_name, address: sender.email },
```
to
```typescript
  from: { name: email.from_display_name ?? sender.display_name, address: sender.email },
```
(Confirm the local variable holding the row is named `email`; if it's `row`/`e`, use that. The row carries `from_display_name` from Task 2.)

- [ ] **Step 5: Run → PASS** (template send From = 'Absa Line'; raw send From = sender name). **Step 6:** run the existing `test/v1Emails.test.ts` for no regression → PASS. **Step 7:** `npm -w server run build` → PASS. **Step 8: Commit**
```bash
git add server/src/send/pipeline.ts server/src/send/dispatch.ts server/test/templateDisplayName.send.test.ts
git commit -m "feat(send): template display_name overrides sender on the From header"
```

---

## Task 4: UI — template "From display name" field

**Files:** Modify `web/src/pages/Templates.tsx`

- [ ] **Step 1:** Add `display_name: string | null` to the `Tpl` interface (line ~12).
- [ ] **Step 2:** Add an optional **"From display name"** text input to the editor form (near subject), bound to the selected template's `display_name` (treat `''` as "clear" → send `null`). Helper text: *"Overrides the sender's name when this template is used. Leave blank to use the sender's name."* Match the form's existing field styling/spacing (8px grid), label always visible.
- [ ] **Step 3:** Include `displayName` in the create body (line ~40) and the PATCH body (lines ~107-109): send `displayName: <value>.trim() || null`. (On create you can omit it or send null; on edit send the field so it can be set/cleared.)
- [ ] **Step 4:** `cd web && npm run build && npx tsc --noEmit` → success; no NEW errors in `Templates.tsx`.
- [ ] **Step 5: Commit**
```bash
git add web/src/pages/Templates.tsx
git commit -m "feat(templates-ui): From display name field on the template editor"
```

---

## Final verification

- [ ] **Suite:** `cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/templates.displayName.test.ts test/emails.fromDisplayName.test.ts test/templateDisplayName.send.test.ts test/v1Emails.test.ts` → all PASS.
- [ ] **Builds:** `npm -w server run build` AND `cd web && npm run build` → both succeed.
- [ ] **Post-deploy manual:** set a "From display name" on First Assist's "Absa Line" template → send a test → the inbox shows that name as the From; a template without one (or a raw send) still shows the sender's name.

---

## Self-review (author)

- **Spec coverage:** templates.display_name + emails.from_display_name (migration) → Task 1/2; repo+routes → Task 1; emails row → Task 2; resolve-at-queue + apply-at-dispatch → Task 3; UI → Task 4.
- **Placeholder scan:** none — code given for every code step; the two send-test/insertEmail "match the real signature" notes are verify-instructions (the harness/signature must be read), not placeholders.
- **Type consistency:** `display_name`/`displayName` (template), `from_display_name`/`fromDisplayName` (email), `from: { name: email.from_display_name ?? sender.display_name }` — consistent across tasks.
- **Backward-compat:** null `from_display_name` ⇒ sender's name (unchanged); raw sends + existing rows unaffected; address never changes. Update preserves on omit, clears on null.
- **Build gotcha:** run `npm -w server run build` before push; confirm `insertEmail`/`createTemplate`/`updateTemplate` real signatures and the dispatch row var name by reading the files.
