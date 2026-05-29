# GUI Revamp — AIployee Brand (dark purple/magenta) Design

**Date:** 2026-05-29
**Status:** Approved
**Scope:** `web/` frontend only. **Pure visual + UX reskin. No functional changes.**

## Hard Constraint

Change **none** of the real functionality of the site. Same routes, same API
calls, same request/response shapes, same auth/tenant behavior, same form
submission logic. Only presentation (markup, classes, tokens, new presentational
components, loading/empty/feedback states) changes. Verification must confirm no
behavior regressed.

## Goal

Revamp the emailer admin UI to match the **aiployee.co.za** brand and make it as
user-friendly as possible. aiployee.co.za is a fully dark purple/magenta theme;
the emailer is currently a light black-and-white theme. We are converting to the
**full dark** brand look with **full UX polish**.

## Brand System (extracted from aiployee.co.za CSS)

Source: `https://aiployee.co.za` `_next` CSS bundle. Exact tokens:

| Role | Value |
|------|-------|
| Background | `#0b0418` |
| Surface | `#1a0b2e` |
| Surface raised | `#231040` |
| Accent (violet) | `#7c3aed` (hover `#9d4efb`, active `#6826c8`) |
| Magenta | `#c026f2` (bright `#d146ff`) |
| Hero gradient | `linear-gradient(135deg, #c026f2 0%, #7c3aed 100%)` |
| Text | `#fff` |
| Text muted | `#d8cfe4` (lavender) |
| Text dim | `#8c7fa8` |
| Border subtle / default / strong | `#2a1a3e` / `#3d2a56` / `#5b4d6e` |
| Focus ring | `#c026f2` |
| Soft tints | magenta `#c026f21f`, violet `#7c3aed1f` |
| Success | `#22c55e` / emerald `#34d399` |
| Error | `#f43f5e` |
| Stat cyan / violet | `#22d3ee` / `#a855f7` |
| Font | Inter (already in use) |
| Radius | full pills (buttons), 24–28px (cards) |
| Texture | subtle violet grid lines (`#7c3aed0a`) |

## Architecture (why this is low-risk)

The app already routes all styling through a semantic token layer:
`design-tokens.json` → `tailwind.config.ts` (semantic names: `bg`, `ink`,
`primary`, `primary-ink`, `muted`, `line`, `surface`) → shared components
(`Button`, `Input`/`Field`, `Table`/`Th`/`Td`, `Modal`, `AppShell`,
`TenantSwitcher`) → 13 pages. Remapping the token layer + upgrading the shared
components reskins ~80% of the app automatically; pages need light touch-ups.

## Work Units

### 1. Token & theme layer
- **`design-tokens.json`** — expand to the full dark palette above.
- **`tailwind.config.ts`** — semantic colors: `bg`, `surface`, `surface-raised`,
  `ink`, `ink-muted`, `ink-dim`, `accent`, `accent-hover`, `accent-active`,
  `magenta`, `magenta-bright`, `line`, `line-strong`, `success`, `error`,
  `cyan`, `violet`; brand gradient utility (`bg-brand`). Keep existing names
  (`primary`, `muted`, etc.) aliased so no page breaks during transition.
- **`theme.css`** — dark `body` (bg `#0b0418`, text `#fff`), magenta text
  selection + default focus ring, subtle fixed violet grid texture behind the
  app, dark-styled scrollbars.

### 2. Shared component upgrades (no API/prop-contract changes)
- **`Button`** — primary = magenta→violet gradient pill, soft glow on hover; add
  `secondary` (outline) variant; keep `ghost` + `danger`. Same props/variants
  superset (existing call sites keep working).
- **`Input` / `Field`** — `surface-raised` fields, lavender labels, magenta focus
  ring.
- **`Table` / `Th` / `Td`** — dark surfaces, lavender header, row hover, rounded.
- **`Modal`** — `surface-raised` panel, backdrop blur, glowing border.
- **`AppShell`** — dark sidebar, gradient wordmark, nav icons (lucide), active
  item magenta accent bar/glow.
- **`TenantSwitcher`** — dark popover matching new surfaces.

### 3. New presentational primitives (`web/src/components/`)
All are pure presentational — they take data already fetched by pages.
- **`StatusBadge`** — colored status pills (sent=emerald, queued=cyan,
  failed/bounced=rose, default=violet).
- **`EmptyState`** — icon + message + optional action slot.
- **`Skeleton`** / **`Spinner`** — loading states.
- **`Toast`** provider + `useToast()` — success/error feedback for save/delete/
  copy actions. Replaces silent mutations; does not change the mutation itself.
- **`Card`** + **`PageHeader`** (title + subtitle + actions) — consistent page tops.

### 4. Page polish (presentation only)
- **Dashboard** — stat cards in the 4 brand stat colors w/ gradient accents;
  loading skeletons; `StatusBadge` in table.
- **Login / AcceptInvite** — centered dark card on gradient/grid backdrop with
  brand wordmark.
- **Onboarding** (`ProgressBar` + steps) — dark/gradient restyle.
- **List pages** (Senders, Templates, SMTP, API keys, Email log, Suppressions,
  Users, Tenants) — `PageHeader`, empty states, loading states, toasts on
  mutations, status badges where relevant.

### 5. Dependency
- Add **`lucide-react`** (icons). Approved.

## Accessibility
White/lavender text on `#0b0418` passes contrast; `ink-dim` only for
non-essential meta; visible magenta focus rings on all interactive elements.

## Testing / Verification
- `cd web && npm run build` must pass (no TS / build errors).
- No web unit tests exist; manually spot-check Login, Dashboard, one list page,
  and a modal render correctly and that flows (login, navigation, a create/edit
  via modal) still behave identically.
- Diff review confirms no API call, route, or data-handling logic changed.

## Out of Scope
- Server / API changes.
- New features, new routes, new data.
- Any change to what the app does — only how it looks.
