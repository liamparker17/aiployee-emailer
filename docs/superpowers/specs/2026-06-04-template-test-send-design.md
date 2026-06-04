# Template Test-Send — Design (v1)

**Date:** 2026-06-04
**Status:** Approved design — ready for implementation planning.
**Motivation:** A tenant can't easily verify a template renders or that their SMTP (e.g. Microsoft Outlook/365) actually connects. A one-click "Send test" that surfaces the **raw SMTP error** is the fastest way to both preview a template and debug a failing sender.

## Approach

A new admin route renders a template with sample variables and sends it **once, inline**, via the real dispatch path, returning success or the underlying provider error. No queue, no schema change. Reuses `getTemplateById`, `getDefaultSender`, `render`, `insertEmail`, `dispatchEmail`.

## Backend — `POST /api/templates/:id/test-send`

In `server/src/routes/templates.ts` (admin-gated, tenant-scoped — same `requireTenantCtx` + `requireAdmin` + `sendError` as siblings):

- **Body (zod):** `{ to: z.string().email(), variables: z.record(z.string(), z.string()).optional() }`. `to` is required (the web prefills it with the logged-in user's email; `ctx` does not carry the email).
- **Resolve:** `tpl = getTemplateById(pool, ctx.tenantId, id)` → 404 if missing. `sender = getDefaultSender(pool, ctx.tenantId)` → 400 `'No default sender configured — add a sender first.'` if none.
- **Sample variables:** for each name in `tpl.variables`, use `body.variables?.[name] ?? name` (so every placeholder renders even if unfilled — the var name is the sample); then apply any extra keys from `body.variables`.
- **Render** (match `pipeline.ts`'s calls exactly): `subject = render(tpl.subject, vars, { escape: false })`, `bodyHtml = render(tpl.body_html, vars)` (escape on — escapes the variable values into HTML), `bodyText = tpl.body_text ? render(tpl.body_text, vars, { escape: false }) : null`.
- **Insert + dispatch:** `email = insertEmail(pool, { tenantId, senderId: sender.id, toAddr: body.to, subject, bodyHtml, bodyText, templateId: tpl.id, fromDisplayName: tpl.display_name?.trim() || null, status: 'queued' })`; then `outcome = dispatchEmail({ pool, encKey: app.cfg.encKey, email, baseUrl: app.cfg.baseUrl })` (confirm the exact `app.cfg` field names for encKey/baseUrl). `dispatchEmail` returns `{ ok: true, messageId } | { ok: false, error }` and records status/error on the row.
- **Response:** `outcome.ok ? reply.send({ ok: true, messageId: outcome.messageId }) : reply.send({ ok: false, error: outcome.error })`. The raw provider error (e.g. the Outlook auth rejection) is returned verbatim so the admin can debug. (200 either way; the `ok` flag carries success.)

Notes: this reuses the real From-display-name (template override → sender fallback). It bypasses suppression (intentional — a test to yourself). The test send is a real `emails` row, so it appears in the Email log (acceptable/useful).

## Web — `web/src/pages/Templates.tsx`

- Client (`web/src/lib/templates` or inline `api()`): `testSendTemplate(id, { to, variables }) → { ok: boolean; messageId?: string; error?: string }`.
- **"Send test" button** on the editor. Clicking reveals a small inline panel:
  - **Recipient** input, prefilled with `useAuth().user?.email ?? ''` (editable).
  - If the template has `variables` (it lists them), a compact set of **variable inputs**, each prefilled with the variable name as a sample (editable).
  - A **Send** action → `testSendTemplate(...)`.
- **States (cover all):** idle; sending (disable + spinner "Sending test…"); success → green notice "Test sent to {to}" (toast); failure → **show the raw error string** in a red, monospace, scrollable block (this is the debugging payload) + a toast. Don't lose the form on error. Admin-only (the page is already admin-gated).

## Safety

- Admin-gated + tenant-scoped; `to` is a validated email; sends via the tenant's own default sender/SMTP.
- Raw error exposure is admin-only and intentional (debugging). No secrets are in SMTP error strings (they're provider responses), but do NOT echo the SMTP password — `dispatchEmail`'s error is the provider's message, not credentials.
- No new send capability beyond the existing dispatch; no schema change.

## Testing

- **Route (reuse `v1Emails.test.ts` harness — app + default sender + `startTestSmtp`):**
  - Admin POST `/api/templates/:id/test-send` with a template containing `{{name}}` → 200 `{ ok: true }`; the test SMTP captures a message whose subject/body reflect the rendered vars and the From shows the template display name (if set).
  - Unfilled variable → renders the sample (var name), still sends.
  - No default sender → 400.
  - Non-admin → 403; unknown template id → 404.
  - Failure path: point the sender's SMTP at a dead port (or stop the test SMTP) → 200 `{ ok: false, error: <non-empty string> }` (proves the raw error is surfaced, not thrown).
- **Web:** `cd web && npm run build` + `tsc --noEmit`.

## Out of scope (v1)

Saving/last-used test recipients; sending to multiple recipients; a full WYSIWYG preview (the existing `/preview` route covers render preview; this is about an actual send + SMTP check); OAuth2 SMTP setup (separate effort).
