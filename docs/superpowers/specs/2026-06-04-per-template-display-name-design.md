# Per-Template From Display Name — Design (v1)

**Date:** 2026-06-04
**Status:** Approved design — ready for implementation planning.
**Builds on:** the send path — `senders.display_name` (`migrations/1700000000002`), `dispatch.ts` (builds the From header from the sender), `pipeline.ts::queueEmail` (resolves a template, renders subject/body, inserts the email row), `templates` repo/routes, `Templates.tsx`.

## Problem

The email "From" display name is set per **sender** (`dispatch.ts:47` → `from: { name: sender.display_name, address: sender.email }`). But a tenant's templates are the real "line" identity (e.g. "First Assist Absa Line" vs "Innovation Overflow") and they all share one sender. Tenants need the From display name to ride with the **template**.

## Approach

A template may set its own From display name; when a send uses that template, the template's name wins. The sender's `display_name` remains the fallback (raw/non-template sends, and templates that don't set one). **The resolved name is locked onto the email row at queue time** — immutable, and correct for scheduled sends even if the template is later edited/renamed/deleted. Address stays the sender's email (only the display name changes).

## Data model (migration `1700000000028_template_display_name.cjs`)

- `templates.display_name text` — nullable. The template's From display name override.
- `emails.from_display_name text` — nullable. The display name resolved at queue time for this specific send (null ⇒ fall back to sender at dispatch).

## Components

### Templates repo — `server/src/repos/templates.ts`
- Add `display_name: string | null` to the `Template` row type.
- `createTemplate` input accepts `displayName?: string | null`; INSERT writes it (trim → null if empty).
- `updateTemplate` input accepts `displayName?: string | null`; included in the partial UPDATE.
- Ensure SELECT/RETURNING includes `display_name`.

### Template routes — `server/src/routes/templates.ts`
- `CreateBody` + `UpdateBody` zod: add `displayName: z.string().max(120).nullable().optional()` (bounded; allow clearing via null).
- Pass `displayName` through to the repo.

### Emails repo — `server/src/repos/emails.ts`
- Add `from_display_name: string | null` to `EmailRow`.
- `insertEmail` accepts + writes `fromDisplayName` (default null). SELECT includes the column.

### Pipeline — `server/src/send/pipeline.ts::queueEmail`
- When a template is resolved (`getTemplateByName`), compute `fromDisplayName = tpl.display_name?.trim() || null`.
- Pass `fromDisplayName` into `insertEmail(...)`. For non-template sends, it's null.

### Dispatch — `server/src/send/dispatch.ts::sendOne`
- Change the From assembly to: `from: { name: email.from_display_name ?? sender.display_name, address: sender.email }`.
- `sendOne` already has the `EmailRow` (it carries `from_display_name`) and the sender — no extra query.

### Web UI — `web/src/pages/Templates.tsx` (+ `Tpl` type)
- Add `display_name: string | null` to the `Tpl` interface.
- Add an optional **"From display name"** input to the editor form, with helper text *"Overrides the sender's name when this template is used. Leave blank to use the sender's name."*
- Include `displayName` in the create + PATCH request bodies (send `null` when cleared).

## Data flow (after)

```
POST /v1/emails (template=X)
  → queueEmail: sender = getSenderByEmail; tpl = getTemplateByName(X)
      render subject/body from tpl; fromDisplayName = tpl.display_name?.trim() || null
      insertEmail({ ..., templateId: tpl.id, fromDisplayName })
  → dispatch.sendOne(emailRow): from = { name: emailRow.from_display_name ?? sender.display_name, address: sender.email }
```

## Safety / compatibility

- **Backward compatible:** existing email rows + all raw/non-template sends have `from_display_name = null` → dispatch falls back to `sender.display_name` exactly as today. No behavior change unless a template sets a display name.
- Address is unchanged (sender's email) — no deliverability/SPF/DKIM impact.
- `display_name` is bounded (≤120 chars) and trimmed; empty ⇒ null (use sender).

## Testing

- **Templates repo:** `display_name` round-trips through create/update (set, clear to null, omit-preserves).
- **Routes:** `POST`/`PATCH /api/templates` accept `displayName`; returns it; clearing with `null` works; over-long rejected.
- **Pipeline:** a send with a template that has a `display_name` stores that on the email row's `from_display_name`; a template without one stores null; a raw send stores null.
- **Dispatch:** From name = template override when present, else sender's name. (Unit-test `sendOne`'s From assembly, or assert via the existing send test harness / smtp-tester that the From header reflects the template name.)
- **Web:** `cd web && npm run build` + `tsc --noEmit` (ignore pre-existing Domains/Segments errors).

## Out of scope (v1)

Per-template From **address** (only the display name is overridable; address stays the sender's); per-template reply-to; a UI preview of the rendered From.
