# Agentic-First UX Reskin — Design (v1)

**Date:** 2026-06-03
**Status:** Approved design — ready for implementation planning.
**Scope:** Frontend only. No backend, no data changes, no new pages, **nothing removed** — pure information-architecture + framing reskin.

## Problem

The app still reads as a transactional/marketing **emailer**, not the agentic product it has become. The landing is an email **Dashboard**; **Abe** is the 2nd nav link; **Calls** is buried under "Activity"; and the nav is dominated by email parity (Sending, Marketing, Integrations). The "crazy cool" agentic value (Abe, call intelligence, callback handovers, call analytics) is scattered and outweighed.

## Approach — agentic-first reskin

Lead with the AI employee; demote the email/marketing/developer machinery into clearly-labelled, collapsed-by-default groups. Same features, completely different feel. End user reads "this is my AI call employee" in ~5 seconds.

## 1. Navigation (the change) — `web/src/components/AppShell.tsx`

New order/grouping in the sidebar:

- **★ Your AI employee** — a top group, always expanded, visually emphasised (the hero):
  - **Abe** → `/t/:id/abe` (his home: identity, callback queue, line reports, chat). Visible to all roles.
  - **Calls** → `/t/:id/calls` (call analytics). Shown for `role !== 'tenant_user'` (unchanged gate).
- **▾ Email setup** (collapsible, collapsed by default): Senders · Domains · SMTP configs · Templates · **Email overview** (the old Dashboard, relabelled) · Email log · Suppressions.
- **▾ Marketing** (collapsible, collapsed): Launch campaign · Contacts · Lists · Segments · Campaigns.
- **▾ Developers** (collapsible, collapsed): API keys · Jobix builder · Event webhooks · AI (Jobix responses, relabelled "AI responses").
- **▾ Admin** (collapsible, collapsed): Users · Tenants (super-admin only, unchanged).

**Collapsible groups:** each secondary group is a button-with-chevron header that expands/collapses its links. Default = collapsed; the "Your AI employee" group has no collapse (always shown). Expanded/collapsed state persists per group in `localStorage` (e.g. `nav.<group>.open`). Keyboard-accessible (button, `aria-expanded`), ≥4.5:1 contrast, existing `link`/`SectionLabel` styling reused.

**Tagline:** under the "Aiployee" logo in the sidebar, add a small muted line *"Your AI call employee."*

## 2. Landing — `web/src/routes.tsx`

The tenant index route `/t/:tenantId` currently renders the email **Dashboard**. Change it so the index **redirects to Abe** (`/t/:tenantId/abe`) — Abe's home becomes the first thing a tenant sees. Keep the Dashboard reachable at `/t/:tenantId/dashboard` (new explicit path) and link it from the **Email overview** nav item; remove it as the index/landing.

> Implementation note: the current router has `{ index: true, element: <Dashboard /> }` under `/t/:tenantId`. Replace with an index that `<Navigate to="abe" replace />`, and add an explicit `{ path: 'dashboard', element: <Dashboard /> }` so nothing 404s. Confirm the `Authed`/`TenantGate` wrappers still apply.

## 3. Framing/copy

The "Your AI employee" group label + Abe's existing identity card (already on his home) carry the repositioning. The logo stays "Aiployee" + the new tagline. No other copy churn.

## What stays the same

- Every feature remains reachable (regrouped, not removed).
- All role gating unchanged (`tenant_user` sees the same allowed set; super-admin sees Tenants).
- No routes deleted except the index now redirects (Dashboard moves to `/dashboard`).

## Testing

- `cd web && npm run build` + `npx tsc --noEmit` (ignore the pre-existing `Domains.tsx`/`Segments.tsx` errors) → succeed.
- Manual smoke: log in as a tenant_admin → land on Abe; the AI group is the hero; secondary groups collapsed; expanding one shows its links and the choice persists on reload; every old link still works; `tenant_user` sees only their allowed items.

## Out of scope (v1)

A brand-new "Home" overview page (Abe's home serves); removing/hiding email or marketing features; two-mode workspace; mobile drawer redesign (keep current responsive behaviour); any backend change.
