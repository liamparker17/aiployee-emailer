# Template Test-Send — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A one-click "Send test" on the template editor that renders the template with sample variables, sends it once via the real dispatch path, and surfaces the raw SMTP error on failure (so a tenant can verify rendering AND debug a failing sender like Outlook/365).

**Architecture:** New admin route `POST /api/templates/:id/test-send` reusing `getTemplateById` → `getDefaultSender` → `render` → `insertEmail` → `dispatchEmail` (returns `{ok,messageId}|{ok:false,error}`). No queue, no migration. Web editor gains a "Send test" panel prefilled with the user's email + sample vars.

**Tech Stack:** TypeScript, Fastify, `pg`, Vitest (serial, Neon test branch) + smtp-tester, React. Spec: `docs/superpowers/specs/2026-06-04-template-test-send-design.md`.

**Verified surfaces (from code):**
- `routes/templates.ts`: `registerTemplateRoutes(app)`; siblings use `requireTenantCtx(req)`, `sendError`, `AppError` (`../util/errors.js`), `z`, `getTemplateById(pool, tenantId, id): Promise<Template|null>`. There's an existing `POST /api/templates/:id/preview` to mirror. **`requireAdmin`** is used in `routes/callAnalytics.ts` — import it the same way (confirm its module path).
- `repos/senders.ts`: `getDefaultSender(pool, tenantId): Promise<Sender|null>` (`Sender` has `id`, `email`, `display_name`, `smtp_config_id`).
- `send/render.ts`: `render(template: string, vars: Record<string,string>, opts?: {escape?: boolean}): string` — missing vars → ''; `escape` default true. (Match how `pipeline.ts` calls it for subject vs html.)
- `repos/emails.ts`: `insertEmail(pool, { tenantId, senderId, toAddr, subject, bodyHtml, bodyText?, templateId?, fromDisplayName?, status?, ... }): Promise<EmailRow>`.
- `send/dispatch.ts`: `dispatchEmail({ pool, encKey: Buffer, email: EmailRow, baseUrl: string }): Promise<{ok:true,emailId,messageId}|{ok:false,emailId,error:string}>` — catches SMTP errors, records status, returns the raw error.
- `Template` row has `variables: string[]`, `subject`, `body_html`, `body_text`, `display_name`.
- Web: `Templates.tsx` editor + `api()` (`web/src/api.ts`); `useAuth().user?.email` (`web/src/auth.tsx`, `SessionUser.email`).
- Test harness: `server/test/v1Emails.test.ts` — `buildApp({cfg})`, `startTestSmtp(port)`, `createTenant`, `createSmtpConfig`, `createSender` (default sender), `smtp.lastMail()`, `getEmail(pool, tenantId, id)`. Admin **session** harness (for the admin/non-admin gate) is in `server/test/callAnalytics.routes.test.ts` — reuse whichever fits.

**Environment (every task):** repo root `C:\Users\liamp\Desktop\tools\Aiployee emailer`; branch `feature/template-test-send`. One test: `cd "/c/Users/liamp/Desktop/tools/Aiployee emailer/server" && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/<file>`. **Before pushing: `npm -w server run build`** (strict tsc). Web: `cd web && npm run build && npx tsc --noEmit` (pre-existing Domains/Segments errors OK). LSP-first: `mcp__ide__getDiagnostics()` once before the first `.ts`/`.tsx` Read, then Read scoped (offset+limit) — TS LSP may be ENOENT, then just use scoped Reads.

---

## Task 1: `POST /api/templates/:id/test-send` route

**Files:** Modify `server/src/routes/templates.ts`; Test `server/test/templates.testSend.test.ts`

- [ ] **Step 1: Read** `server/src/routes/templates.ts` (the `preview` route to mirror structure), `server/src/send/pipeline.ts` (how it calls `render` for subject vs html, and the `insertEmail` field names it uses), `server/src/send/dispatch.ts` (`dispatchEmail` signature + how `app.cfg` exposes `encKey`/`baseUrl` — grep `cfg.encKey`/`cfg.baseUrl`/`app.cfg` usages in other dispatch callers like `marketing/campaignSend.ts` or the v1 send route), and confirm `requireAdmin`'s import path (used in `routes/callAnalytics.ts`).

- [ ] **Step 2: Failing test** `server/test/templates.testSend.test.ts` — reuse the `v1Emails.test.ts` harness (app + default sender + `startTestSmtp`). Create a template via `createTemplate(pool, { tenantId, name, subject:'Hi {{name}}', bodyHtml:'<p>Hello {{name}}</p>', bodyText:null })`. Authenticate as an ADMIN (use the session harness from `callAnalytics.routes.test.ts` OR, if simpler in this app, an admin session login helper — match an existing admin route test). Then:
```typescript
// happy path: renders + sends, From reflects sender; returns ok
// (pseudostructure — fill in from the real harness)
it('test-send renders the template and sends', async () => {
  // ... admin session, tenant, default sender (display 'Sender Co'), template 'greet' with {{name}}
  const recv = smtp.lastMail();
  const res = await adminInject('POST', `/api/templates/${tplId}/test-send`, { to: 'me@x.com', variables: { name: 'Liam' } });
  expect(res.statusCode).toBe(200);
  expect(res.json().ok).toBe(true);
  const mail = await recv as { headers: Record<string,string> };
  expect(mail.headers.subject).toContain('Hi Liam');
});

it('unfilled variable renders the sample (var name) and still sends', async () => {
  // POST with no variables → subject becomes 'Hi name', ok:true
});

it('no default sender → 400', async () => { /* tenant w/o default sender */ });
it('unknown template id → 404', async () => { /* random uuid */ });
it('non-admin → 403', async () => { /* tenant_user session */ });
```
> Mirror the EXACT auth/session + SMTP mechanics of the existing tests (admin session for the gate; `startTestSmtp` + `smtp.lastMail()` for capture). If wiring an admin SESSION is heavy, check whether template routes accept an API-key context too — but the spec says admin-gated, so prefer the session harness used by other `/api/*` admin route tests. Keep at least: happy-path send, no-sender 400, non-admin 403.

- [ ] **Step 3: Run → FAIL** (route 404).

- [ ] **Step 4: Implement** the route in `registerTemplateRoutes` (place near `preview`), adapting field names to what Step 1 confirmed:
```typescript
  app.post('/api/templates/:id/test-send', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const { id } = req.params as { id: string };
      const body = z.object({
        to: z.string().email(),
        variables: z.record(z.string(), z.string()).optional(),
      }).parse(req.body);
      const tpl = await getTemplateById(app.pool, ctx.tenantId, id);
      if (!tpl) throw new AppError('not_found', 404, 'Template not found');
      const sender = await getDefaultSender(app.pool, ctx.tenantId);
      if (!sender) throw new AppError('no_sender', 400, 'No default sender configured — add a sender first.');
      const vars: Record<string, string> = {};
      for (const name of tpl.variables ?? []) vars[name] = body.variables?.[name] ?? name;
      if (body.variables) for (const [k, v] of Object.entries(body.variables)) vars[k] = v;
      const email = await insertEmail(app.pool, {
        tenantId: ctx.tenantId,
        senderId: sender.id,
        toAddr: body.to,
        subject: render(tpl.subject, vars, { escape: false }),
        bodyHtml: render(tpl.body_html, vars),
        bodyText: tpl.body_text ? render(tpl.body_text, vars, { escape: false }) : null,
        templateId: tpl.id,
        fromDisplayName: tpl.display_name?.trim() || null,
        status: 'queued',
      });
      const outcome = await dispatchEmail({ pool: app.pool, encKey: app.cfg.encKey, email, baseUrl: app.cfg.baseUrl });
      if (outcome.ok) reply.send({ ok: true, messageId: outcome.messageId });
      else reply.send({ ok: false, error: outcome.error });
    } catch (e) { sendError(reply, e); }
  });
```
Add imports: `requireAdmin` (same source as callAnalytics uses), `getDefaultSender` from `../repos/senders.js`, `render` from `../send/render.js`, `insertEmail` from `../repos/emails.js`, `dispatchEmail` from `../send/dispatch.js`. **Verify** `app.cfg.encKey`/`app.cfg.baseUrl` are the real field names (Step 1) — if dispatch's baseUrl comes from elsewhere (e.g. `app.cfg.publicUrl`/`appUrl`), use that. Match `insertEmail`'s real required fields + the subject/html `render` escape flags to `pipeline.ts`.

- [ ] **Step 5: Run → PASS** (all cases). **Step 6:** `npm -w server run build` → PASS. **Step 7:** run `test/v1Emails.test.ts` for no regression → PASS. **Step 8: Commit**
```bash
git add server/src/routes/templates.ts server/test/templates.testSend.test.ts
git commit -m "feat(templates): POST /api/templates/:id/test-send (renders + sends, surfaces SMTP error)"
```

---

## Task 2: Web — "Send test" panel on the template editor

**Files:** Modify `web/src/pages/Templates.tsx` (+ a client call; add to `web/src/lib/templates.ts` if that file exists, else inline `api()`)

- [ ] **Step 1: Client** — add a `testSendTemplate` call (match the file's `api()` idiom):
```typescript
export const testSendTemplate = (id: string, payload: { to: string; variables?: Record<string, string> }) =>
  api<{ ok: boolean; messageId?: string; error?: string }>(`/api/templates/${id}/test-send`, {
    method: 'POST', body: JSON.stringify(payload),
  });
```
(If templates have no dedicated lib file, define it inline in `Templates.tsx` using the imported `api`.)

- [ ] **Step 2: UI** — in `Templates.tsx`, read the user via `useAuth()` (`const { user } = useAuth();`). Add a **"Send test"** button to the editor. Toggling it shows an inline panel with:
  - **Recipient** text input, default `user?.email ?? ''` (local state, editable).
  - For each name in the selected template's `variables` (the editor has the template; if `variables` isn't already in the `Tpl` type/state, derive from the body or add it — simplest: keep a `Record<string,string>` keyed by the template's `variables` list, each defaulting to the var name). Render one small labelled input per variable.
  - A **Send** button.
- [ ] **Step 3: Behavior + states** (cover all):
  - On Send: validate the recipient is non-empty; set `sending=true` (disable Send + show a spinner "Sending test…"); call `testSendTemplate(sel.id, { to, variables })`.
  - Success (`res.ok === true`): `toast.success('Test sent to ' + to)` (use the page's toast mechanism if present; else a small inline green notice). Keep the panel open.
  - Failure (`res.ok === false`): show `res.error` in a **red, monospace, scrollable** block below the form (this is the debugging payload — e.g. the Outlook auth error), plus a toast/inline error. Do NOT clear the inputs.
  - Network/throw (the `api()` helper throws on non-2xx — but this route returns 200 with `ok:false`, so the error path is the `res.ok===false` branch; still wrap in try/catch and show the thrown message if it throws): show the message in the same error block.
  - Always clear `sending` in a finally.
  - Reuse existing button/input/spinner/toast components and 8px-grid styling; labels always visible.
- [ ] **Step 4:** `cd web && npm run build && npx tsc --noEmit` → success (no NEW errors in `Templates.tsx`). **Step 5: Commit**
```bash
git add web/src/pages/Templates.tsx web/src/lib/templates.ts
git commit -m "feat(templates-ui): Send test panel (prefilled recipient + sample vars, shows raw SMTP error)"
```

---

## Final verification

- [ ] **Suite:** `cd server && TEST_DATABASE_URL="$(cat /c/Users/liamp/.aiployee-test-db-url)" npx vitest run test/templates.testSend.test.ts test/v1Emails.test.ts test/templates.route.test.ts` → all PASS.
- [ ] **Builds:** `npm -w server run build` AND `cd web && npm run build` → both succeed.
- [ ] **Post-deploy manual:** open a template → "Send test" → recipient prefilled with your email → Send → you receive it (From reflects the template display name). For the Outlook debug: with the failing sender as default, the panel shows the raw SMTP error verbatim.

---

## Self-review (author)

- **Spec coverage:** route (render+insert+dispatch+raw error) → Task 1; UI (prefilled recipient + sample vars + raw error block) → Task 2.
- **Placeholder scan:** none — concrete code; "confirm app.cfg field names / insertEmail fields / render escape flags" are verify-instructions (must read pipeline.ts/dispatch.ts).
- **Type consistency:** `testSendTemplate(id, {to, variables?})` ↔ route body `{to, variables?}` ↔ response `{ok, messageId?, error?}` — consistent.
- **Reuse/safety:** real dispatch path (From display name honored), admin-gated, validated email, raw error is admin-only + intentional. No migration.
- **Risk:** the exact `app.cfg.encKey`/`baseUrl` names and `insertEmail` required fields — Task 1 Step 1 reads them first; build gate catches mismatches.
