# Onboarding UX Rework — Super-admin Tenant Picker + Wizard

**Date:** 2026-05-28
**Status:** Approved (design)
**Audience:** Super-admin (only authed role today)

## Problem

After login the app drops users into a per-tenant `AppShell` with a sidebar
(Dashboard, Senders, Templates, SMTP, API Keys, Log, Suppressions, Users,
Admin/Tenants). To get a working test email out, a new operator must
discover the right order — create tenant → create SMTP config → create
sender → create template → trigger send — on their own. There is no
guided path and no first-run state.

Goal: a super-admin who just logged in should be able to (a) pick an
existing tenant, or (b) create a new tenant and send a verified test
email, without prior knowledge of the data model.

## Scope

In scope:
- New post-login landing: **TenantPicker**.
- New **`/onboarding`** wizard: Tenant → Sender+SMTP → Test send.
- Move existing per-tenant pages under a **`/t/:tenantId/*`** route prefix.
- Keep `/admin/tenants` as the advanced management surface.
- Tenant switcher in the `AppShell` header for fast cross-tenant jumps.

Out of scope:
- Tenant deletion from the picker (stays on admin page).
- Multi-step template authoring inside the wizard.
- Role-aware branching for non-super-admin users (no such role exists yet).
- New backend endpoints — the wizard orchestrates existing tenant / SMTP /
  sender / send-email APIs.

## Routing

| Path | Renders | Notes |
|------|---------|-------|
| `/login` | `Login` | unchanged |
| `/accept-invite` | `AcceptInvite` | unchanged |
| `/` | `TenantPicker` (authed) | new landing |
| `/onboarding` | `OnboardingWizard` (authed) | new |
| `/t/:tenantId` | `AppShell` → `Dashboard` | moved |
| `/t/:tenantId/senders` | `AppShell` → `Senders` | moved |
| `/t/:tenantId/templates` | `AppShell` → `Templates` | moved |
| `/t/:tenantId/smtp` | `AppShell` → `SmtpConfigs` | moved |
| `/t/:tenantId/api-keys` | `AppShell` → `ApiKeys` | moved |
| `/t/:tenantId/log` | `AppShell` → `EmailLog` | moved |
| `/t/:tenantId/suppressions` | `AppShell` → `Suppressions` | moved |
| `/t/:tenantId/users` | `AppShell` → `Users` | moved |
| `/admin/tenants` | `AdminTenants` (authed, no shell) | unchanged location, advanced ops |

`tenantId` becomes the source of truth for which tenant the shell is
operating on. `AppShell` reads it from the route param and passes it to
descendants via existing context (or replaces any prior implicit
"current tenant" state).

Legacy paths (`/senders`, `/templates`, …) redirect to
`/t/:lastUsedTenantId/<segment>` when a last-used tenant exists in
localStorage, otherwise to `/`.

## TenantPicker (`/`)

Layout:
- Header: app logo, current user email, "Sign out".
- Title row: **"Tenants"** + right-aligned **"+ New tenant"** primary button.
- Search input above the grid; rendered only when tenant count > 8.
- Grid of tenant cards (responsive: 1/2/3 columns).

Card content:
- Tenant name (large).
- Slug (muted).
- Last-activity timestamp ("Last email 3h ago" / "No activity yet").
- Small status pill: count of emails sent today (e.g. "12 today" / "Idle").
- If wizard was abandoned for this tenant: yellow "Setup incomplete" badge.
- Click anywhere on card → navigate to `/t/:id`.
- Click "Setup incomplete" badge → resume wizard at the step it was
  abandoned on.

Empty state (zero tenants):
- Single centered card: "No tenants yet. Create your first one."
- Primary CTA "+ New tenant" → `/onboarding`.
- No grid, no search input.

Data source: existing `GET /api/admin/tenants` (or equivalent).
"Last activity" + "sent today" come from an existing aggregate endpoint if
present; otherwise a small additive endpoint is acceptable but not
required for the v1 ship — placeholder text "—" is fine until then.

## OnboardingWizard (`/onboarding`)

Full-page flow (not a modal). Progress bar with three steps:
**Tenant → Sender → Test**. "Back" goes to previous step (data preserved
in component state). "Cancel" returns to `/` with a confirm prompt if
step 1 has not yet been submitted.

Resumability: the wizard accepts a `?tenantId=…&step=…` query param so an
abandoned tenant from the picker reopens at the right step.

### Step 1 — Tenant

Fields:
- **Name** (required, free text).
- **Slug** (required, auto-derived from name via kebab-case; editable;
  validated for uniqueness inline on blur).

Action:
- "Next" calls existing `POST /api/admin/tenants`. On success, stash the
  new tenant id in component state + URL (`?tenantId=…&step=2`) so
  refresh is safe.

### Step 2 — Sender + SMTP

Fields:
- **From name** (required).
- **From email** (required, RFC-validated).
- **Provider preset** chip group: Gmail, Outlook, Custom.
  - Gmail / Outlook auto-fill host, port, secure flag.
  - Custom reveals host / port / secure inputs.
- **SMTP username** (required).
- **SMTP password** (required, masked).

Buttons:
- **Test connection** (secondary): calls existing SMTP verify endpoint;
  shows green check or red error message inline. Optional but encouraged.
- **Next** (primary): creates SMTP config + sender atomically via the
  existing inline-SMTP-from-sender flow added in commit `2ea5cca`.
  On failure, stay on step 2 with error.

### Step 3 — Send test

Fields:
- **Send test to** (required, defaults to logged-in user's email).
- Collapsed-by-default disclosure: "Customize subject and body" reveals:
  - **Subject** (default: `Test from {{tenant.name}}`).
  - **Body** (default: `If you can read this, your setup works.`).

Action:
- **Send test** (primary) → posts via existing email send endpoint using
  an *inline* synthetic template (no `templates` row inserted).
- Live status panel below the form:
  - `queued` → spinner + "Queued…".
  - `sent` → green check + "Delivered (or accepted by SMTP). Check the
    inbox of <addr>."
  - `failed` → red icon + the raw SMTP error string + button
    "Back to SMTP settings" (returns to step 2).

Success screen (replaces form once status = sent):
- Heading: "All set."
- Primary CTA "Go to tenant dashboard" → `/t/:tenantId`.
- Secondary CTA "Send another test" → reset step 3 form.

## AppShell header changes

Add a **tenant switcher** dropdown in the existing top bar:
- Trigger: current tenant name + chevron.
- Menu: list of all tenants (same data as picker), search input if >8.
- Footer items:
  - **"← All tenants"** → `/`.
  - **"+ New tenant"** → `/onboarding`.

The switcher is the only new piece in `AppShell`; child pages are
unaffected beyond receiving `tenantId` from the route param instead of
whatever implicit source they used before.

## Data flow

```
Login → /
  TenantPicker
    GET /api/admin/tenants → grid
    "+ New tenant" → /onboarding
    Card click → /t/:id

/onboarding
  step 1: POST /api/admin/tenants                 → tenantId
  step 2: POST /api/tenants/:tenantId/smtp-configs  (existing)
          POST /api/tenants/:tenantId/senders       (existing, inline-SMTP variant)
          optional: POST /api/.../smtp-verify       (existing)
  step 3: POST /api/tenants/:tenantId/emails      (existing, inline subject/body/to)
          poll GET /api/tenants/:tenantId/emails/:id until status terminal
  success: → /t/:tenantId
```

Endpoint names above are illustrative — the plan phase will pin them to
the exact routes already in `server/`.

## Error handling

- Tenant creation conflict (slug taken): inline error on slug field,
  stay on step 1.
- SMTP verify failure: inline red, allow continuing anyway (user may
  want to save and fix later) — but block "Next" by default; offer a
  "Save anyway" link.
- Sender creation failure: stay on step 2, error banner above form.
- Test send failure: render the SMTP error verbatim; offer "Back to SMTP
  settings" deep-link that re-opens step 2 with the existing sender
  pre-loaded for edit (uses sender id from step 2's response).

## Testing

- **Unit (web):** TenantPicker renders empty state with zero tenants;
  renders grid with N tenants; "Setup incomplete" badge appears for
  tenants flagged in localStorage.
- **Unit (web):** Wizard step transitions, slug auto-derive,
  preset auto-fill, "Save anyway" path.
- **Integration (server):** existing tenant/SMTP/sender/send endpoints
  remain unchanged — no new server tests required, but a smoke test
  that walks the three wizard endpoints end-to-end against the Neon
  test branch is a nice-to-have.
- **Manual:** run full wizard locally against a real SMTP (Gmail
  app-password) and confirm the test email lands.

## Open questions resolved during brainstorming

- Landing shape → tenant picker (not aggregate dashboard, not always-wizard).
- Wizard scope → 3 steps ending in a verified test send (not 2, not 5).
- Audience → super-admin only; no role-aware branching today.


## Known follow-ups (after v1 ship)

- Step-2 resume of an incomplete tenant does not repopulate the SMTP form — re-submitting will conflict on `name_taken` ("${tenantName} default" is non-unique on retry). Workaround: delete the incomplete tenant from `/admin/tenants` and start over.
- Tenant card stats ("last activity", "X sent today") on TenantPicker not rendered — needs a server aggregate endpoint.
- `cfg.username` used as `From:` address in test send works for Gmail/Outlook (where username IS email) but could fail for SES IAM-style usernames. Future fix: prefer the wizard's `sender.email` for the test, fall back to `noreply@from_domain` only when explicitly chosen.
- Production send path (`server/src/send/dispatch.ts`) still records only `(e as Error).message` in `markFailed`. The structured SMTP error treatment from `routes/smtpConfigs.ts` test handler should be propagated here so production failures also log code+response+command. Follow-up.
