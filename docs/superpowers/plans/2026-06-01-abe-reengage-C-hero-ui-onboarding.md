# Abe Re-engage — Plan C: Hero UI + "Hire an Employee" Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make Abe the **hero surface** of the app — a top-level "Abe" page that feels like managing a colleague (status + work-log/activity feed + pending-approval plays + a "Manage Abe" panel), plus a **"hire Abe" onboarding wizard** that frames first-run setup as onboarding a new employee.

**Architecture:** A new top-level route `/t/:tenantId/abe` (nav item "Abe", promoted above the tool groups). One page component `Abe.tsx` that branches on whether Abe is "hired" (an enabled goal exists): **not hired → the hiring wizard**; **hired → the hero work-log surface**. All data via the existing `api()` client against the shipped B1–B3 endpoints. Reuses the existing design system (tokens + `components/`). No new backend.

**Tech Stack:** React 18 + React Router 6 + TypeScript + Tailwind (Aiployee tokens), Vite. **No frontend test harness exists** — verification is `cd web && npm run build` (which runs tsc) + manual/visual check via the running app.

**Builds on:** B1+B2+B3 (shipped). **Spec:** `docs/superpowers/specs/2026-06-01-agentic-employee-reengage-design.md` (see "Positioning & onboarding" + "UI — Abe's home").

---

## Verification model (read first — there are NO automated frontend tests)

The `web/` app has **no vitest/RTL setup** (confirmed). Adding one is out of scope for this plan. Each task is therefore verified by:
1. **`cd web && npm run build`** — must compile with zero TS errors (Vite runs `tsc`). This is the hard gate per task.
2. **Manual/visual check** — run the app (`cd web && npm run dev`, or the `run` skill) and confirm the screen renders + the documented interaction works against a tenant whose backend has Abe data. Capture a screenshot if possible.

Do NOT write `*.test.tsx` files (no runner). If the controller wants automated coverage, that's a separate "add RTL to web" project.

---

## Design system to reuse (exact)

- **Tokens (Tailwind):** `bg-bg` `bg-surface` `bg-surface-raised`; text `text-ink` `text-ink-muted` `text-ink-dim`; accents `text-magenta` `text-accent` `bg-brand` (gradient); borders `border-line` `border-line-strong`; status `text-success`/`text-error`/`text-cyan`/`text-violet`; `rounded-btn`, `shadow-glow`; fonts `font-heading`/`font-sans`.
- **Components (`web/src/components/`):** `Button` (`variant: primary|secondary|ghost|danger`), `Input`, `Field` (`label`, `hint`), `Card`, `Modal` (`open`, `onClose`, `title`), `PageHeader` (`title`, `subtitle`, `actions`), `Table/Th/Td`, `StatusBadge` (`status`), `EmptyState` (`icon`, `title`, `description`, `action`), `Skeleton`, `Spinner`, `useToast()` → `{ success, error }`, `Logo`.
- **API client:** `import { api } from '../api'` → `api<T>(path, opts?)`; CSRF auto-added for non-GET; throws `Error & { code, status }`.
- **Auth:** `import { useAuth } from '../auth'` → `user` has `role: 'super_admin'|'tenant_admin'|'tenant_user'`. Admin-only controls (goal edits, approve/reject, verify) should be gated on `role !== 'tenant_user'` in the UI (the API enforces it too).
- **Icons:** `lucide-react` (e.g. `Bot`, `Sparkles`, `Mail`, `Check`, `X`, `Clock`).

---

## Types (shared) — add to the page or a `web/src/lib/abe.ts`

```ts
export interface AbeGoal {
  id: string; enabled: boolean;
  dormant_window_days: number; auto_fire_max_audience: number;
  max_touches: number; touch_spacing_days: number;
  line_manager_email: string | null; line_manager_verified_at: string | null;
  brand_voice: string | null;
}
export interface AbeTouch { index: number; subject: string; body_html: string; scheduled_offset_days: number }
export type AbePlayStatus = 'proposed'|'pending_approval'|'approved'|'rejected'|'executing'|'done'|'archived';
export interface AbePlay {
  id: string; status: AbePlayStatus; risk_score: number;
  audience_snapshot: { contact_ids: string[]; size: number };
  touches: AbeTouch[]; rejection_reason: string | null;
  executed_at: string | null; created_at: string;
}
export interface AbeFeedEntry { playId: string; at: string; kind: string; text: string }
```
(`GET /api/agent/goals` → `{ goal: AbeGoal | null }`; `GET /api/agent/plays` → `{ plays: AbePlay[] }`; `GET /api/agent/feed` → `{ feed: AbeFeedEntry[] }`; `PUT /api/agent/goals` body uses camelCase: `enabled, dormantWindowDays, autoFireMaxAudience, maxTouches, touchSpacingDays, lineManagerEmail, brandVoice`.)

---

### Task 1: Route + nav — promote "Abe" to top-level

**Files:** Modify `web/src/routes.tsx`, `web/src/components/AppShell.tsx`. Create `web/src/pages/Abe.tsx` (stub).

- [ ] **Step 1: Stub page** — create `web/src/pages/Abe.tsx`:
```tsx
import { PageHeader } from '../components';
export default function Abe() {
  return <div><PageHeader title="Abe" subtitle="Your AI re-engagement employee" /></div>;
}
```
(Confirm the exact import style for components — the map shows named exports from `../components`; match how `AiResponses.tsx` imports them, e.g. `import PageHeader from '../components/PageHeader'` if they're default exports. Adjust accordingly.)

- [ ] **Step 2: Route** — in `routes.tsx`, add `{ path: 'abe', element: <Abe /> }` to the `/t/:tenantId` children (import `Abe` at top). Put it first among the tenant children so it's the prominent destination.

- [ ] **Step 3: Nav** — in `AppShell.tsx`, add a prominent nav link ABOVE the first `SectionLabel` (so Abe sits at the top, not buried in a group):
```tsx
<NavLink to={`${base}/abe`} className={link}><Bot size={16} />Abe</NavLink>
```
Import `Bot` from `lucide-react` if not already. (The existing "AI responses"/`ai-responses` Jobix page stays where it is — that's the reactive Jobix responder, distinct from Abe the proactive re-engage employee. Optionally relabel it "Jobix agent" for clarity, but that's not required here.)

- [ ] **Step 4: Build** — `cd web && npm run build` → compiles clean. Visually confirm the "Abe" nav item appears at the top and routes to the stub page.

- [ ] **Step 5: Commit**
```bash
git add web/src/routes.tsx web/src/components/AppShell.tsx web/src/pages/Abe.tsx
git commit -m "feat(abe-C): top-level Abe route + nav (stub page)"
```

---

### Task 2: Data layer + "hired vs not" branch

**Files:** Modify `web/src/pages/Abe.tsx`. Optionally create `web/src/lib/abe.ts` (the types above).

- [ ] **Step 1: Implement the page shell** — load the goal; branch on hired state (hired = `goal && goal.enabled`):
```tsx
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Spinner } from '../components';
import type { AbeGoal } from '../lib/abe';
import AbeHome from '../components/abe/AbeHome';
import HireAbeWizard from '../components/abe/HireAbeWizard';

export default function Abe() {
  const [goal, setGoal] = useState<AbeGoal | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = () => api<{ goal: AbeGoal | null }>('/api/agent/goals').then(r => setGoal(r.goal));
  useEffect(() => { reload().finally(() => setLoading(false)); }, []);

  if (loading) return <div className="p-8"><Spinner /></div>;
  const hired = !!goal?.enabled;
  return hired
    ? <AbeHome goal={goal!} onChange={reload} />
    : <HireAbeWizard goal={goal} onHired={reload} />;
}
```
Create the `web/src/components/abe/` directory; `AbeHome` and `HireAbeWizard` are stubs for now (return `<div/>`), fleshed out in later tasks.

- [ ] **Step 2: Build** → clean. **Step 3: Commit**
```bash
git add web/src/pages/Abe.tsx web/src/lib/abe.ts web/src/components/abe/
git commit -m "feat(abe-C): Abe page data layer + hired/not-hired branch"
```

---

### Task 3: The "Hire Abe" onboarding wizard

**Files:** Create `web/src/components/abe/HireAbeWizard.tsx`.

A 5-step wizard (spec "Positioning & onboarding"): **Meet Abe → Assign manager → Brief the goal → Working limits → Start first shift.** It collects goal fields and on finish `PUT`s the goal with `enabled: true`, then calls `onHired()`.

- [ ] **Step 1: Implement** — local step state (0–4), a form object seeded from the (possibly null) `goal`, employee-voiced copy per step, and `Button` nav. Key steps:
  - **0 Meet Abe:** intro copy ("Abe re-engages contacts who've gone quiet…"), `Next`.
  - **1 Manager:** `Field label="Who does Abe report to?"` → `Input` for `lineManagerEmail` (email). Note: verification happens after hiring (Task 5).
  - **2 Goal:** confirm dormant window in plain language — `Field label="Win back contacts quiet for…"` → number `Input` `dormantWindowDays` (default 60).
  - **3 Working limits (the "employment agreement"):** `autoFireMaxAudience` (default 0, with copy "0 = Abe always asks before sending"), `maxTouches` (default 3), `touchSpacingDays` (default 3), optional `brandVoice` textarea.
  - **4 Start first shift:** summary of the agreement + a primary `Button` "Hire Abe & start his first shift" that does:
```tsx
await api('/api/agent/goals', { method: 'PUT', body: JSON.stringify({
  enabled: true, lineManagerEmail: form.lineManagerEmail || null,
  dormantWindowDays: form.dormantWindowDays, autoFireMaxAudience: form.autoFireMaxAudience,
  maxTouches: form.maxTouches, touchSpacingDays: form.touchSpacingDays,
  brandVoice: form.brandVoice || null,
}) });
toast.success('Abe is hired — he starts his first shift on the next cycle.');
onHired();
```
  Use `useToast()`. Gate the final action on admin role (show a note for `tenant_user`).
  Use `Card` for the wizard body, a simple step indicator (e.g. "Step 2 of 5"), and the brand tokens. Keep copy first-person/employee-framed throughout.

- [ ] **Step 2: Build** → clean. Visually walk the 5 steps; confirm finishing creates an enabled goal and flips the page to `AbeHome`.

- [ ] **Step 3: Commit**
```bash
git add web/src/components/abe/HireAbeWizard.tsx
git commit -m "feat(abe-C): Hire-Abe onboarding wizard (meet -> manager -> goal -> limits -> start)"
```

---

### Task 4: Abe's home — header + work-log (activity feed)

**Files:** Create `web/src/components/abe/AbeHome.tsx`, `web/src/components/abe/AbeFeed.tsx`.

- [ ] **Step 1: AbeFeed** — fetch `GET /api/agent/feed` → render first-person entries reverse-chron in a timeline (each: an icon by `kind`, the `text`, a relative time from `at`). Use `EmptyState` (icon `Sparkles`, "Abe hasn't logged anything yet — he'll post here after his first shift.") when empty; `Skeleton` while loading.
```tsx
const [feed, setFeed] = useState<AbeFeedEntry[] | null>(null);
useEffect(() => { api<{ feed: AbeFeedEntry[] }>('/api/agent/feed').then(r => setFeed(r.feed)); }, []);
```

- [ ] **Step 2: AbeHome** — compose the hero:
  - **Header:** `Bot` avatar + "Abe" + a status line derived from plays/goal ("On shift · re-engaging dormant contacts" / "Waiting on <manager> to approve a play" / "Resting — no dormant contacts right now"). Reuse `PageHeader` with custom `actions` or a custom header block using `Card`.
  - **Body:** the `AbeFeed` work-log as the primary column; a "Manage Abe" entry point (button/link opening the panel from Task 6).
  - Employee-voiced throughout ("Abe's work log", "Abe is waiting on your approval").

- [ ] **Step 3: Build** → clean. Visually confirm header + feed render (seed a play/feed entry on the test tenant if needed).

- [ ] **Step 4: Commit**
```bash
git add web/src/components/abe/AbeHome.tsx web/src/components/abe/AbeFeed.tsx
git commit -m "feat(abe-C): Abe home — status header + work-log feed"
```

---

### Task 5: Pending-approval plays + Approve/Reject

**Files:** Create `web/src/components/abe/PendingApprovals.tsx`. Modify `AbeHome.tsx` to include it.

- [ ] **Step 1: Implement** — fetch `GET /api/agent/plays`, filter `status === 'pending_approval'`. For each, a `Card` showing audience size, the touches (subject lines + day offsets), and (admin only) `Approve` / `Reject` buttons:
```tsx
async function approve(id: string) {
  await api(`/api/agent/plays/${id}/approve`, { method: 'POST' });
  toast.success('Approved — Abe is sending it now.'); reload();
}
async function reject(id: string) {
  const reason = prompt('Why is Abe holding off? (optional)') ?? '';
  await api(`/api/agent/plays/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
  toast.success('Rejected.'); reload();
}
```
Show a note "Abe also emailed this to <manager> for sign-off" when the goal has a verified line manager (the spec's dual-channel cue). When none pending, render nothing (the feed carries the narrative) or a small "Nothing needs your sign-off" line.

- [ ] **Step 2: Build** → clean. Visually confirm a pending play shows with Approve/Reject and that approving flips its status (re-fetch).

- [ ] **Step 3: Commit**
```bash
git add web/src/components/abe/PendingApprovals.tsx web/src/components/abe/AbeHome.tsx
git commit -m "feat(abe-C): pending-approval plays with Approve/Reject"
```

---

### Task 6: "Manage Abe" panel (goal + line-manager verify)

**Files:** Create `web/src/components/abe/ManageAbe.tsx`. Wire a button in `AbeHome.tsx` to open it (a `Modal` or a slide-over).

- [ ] **Step 1: Implement** — a form (admin only) bound to the goal: `enabled` toggle (pause/resume Abe), `dormantWindowDays`, `autoFireMaxAudience`, `maxTouches`, `touchSpacingDays`, `lineManagerEmail`, `brandVoice`. Save via `PUT /api/agent/goals` (camelCase body) → `toast.success('Saved.')` → `onChange()`.
  - **Line-manager verification:** show `line_manager_verified_at` state. If a `line_manager_email` is set but unverified, a `Button` "Send verification email" → `POST /api/agent/goals/verify-manager` → toast "Verification email sent to <email>." Copy: "Abe can only email his manager for sign-off once the address is verified."
  - Frame as managing an employee ("Abe's working limits", "Who Abe reports to", "Pause Abe").

- [ ] **Step 2: Build** → clean. Visually confirm editing + save round-trips, and the verify button sends.

- [ ] **Step 3: Commit**
```bash
git add web/src/components/abe/ManageAbe.tsx web/src/components/abe/AbeHome.tsx
git commit -m "feat(abe-C): Manage Abe panel (working limits + line-manager verify)"
```

---

### Task 7: Polish + final build/visual pass

**Files:** Across `web/src/components/abe/*`.

- [ ] **Step 1: States** — confirm every surface handles loading (`Skeleton`/`Spinner`), empty (`EmptyState`), and error (`useToast().error` on `api()` rejections) states. Confirm `tenant_user` (non-admin) sees read-only views (no Approve/Reject/Save/Hire actions) — gate on `useAuth().user.role`.
- [ ] **Step 2: Accessibility/visual** — buttons have discernible labels; the wizard is keyboard-navigable; brand tokens used consistently (no raw hex); first-person "Abe" voice consistent.
- [ ] **Step 3: Full build** — `cd web && npm run build` → clean (outputs to `server/public`). Launch the app and walk: hire wizard → home → (seed a pending play) approve → manage panel → verify-manager.
- [ ] **Step 4: Commit**
```bash
git add web/src/
git commit -m "feat(abe-C): polish — loading/empty/error states, role gating, a11y"
```

---

## Production / deploy

- [ ] The web build outputs to `server/public` (served by the server). A normal `master` push → Vercel auto-deploy ships the UI. No migration needed (frontend only).
- [ ] Reminder (carried from B1–B3, separate from this plan): the **crons** (`abe-shift`/`abe-touches`/`abe-outcomes`) still need registering in the scheduler for Abe to actually run; until then the UI works but Abe won't produce plays on his own.

---

## Self-Review (completed during planning)

**1. Spec coverage:**
- Abe as top-level hero (not a sub-tab) → Task 1 (nav promoted) + Task 4 (home). ✓
- Hiring/onboarding = employee setup (meet → manager → goal → limits → start first shift) → Task 3. ✓
- Work-log / teammate feed (first-person) → Task 4 (consumes B3 `/api/agent/feed`). ✓
- Pending-approval with Approve/Reject + "also emailed to manager" cue → Task 5. ✓
- Manage Abe (working limits) + line-manager verify → Task 6. ✓
- Employee-voiced copy throughout → Tasks 3–7. ✓
- *Deferred (noted):* per-play "View & Edit" deep-dive page and in-feed reply-to-steer (the spec's reply box) — can follow once the hero surface lands; not blocking the centerpiece.

**2. Placeholder scan:** Tasks describe concrete files, real endpoints (camelCase PUT body), real components/tokens, and concrete handler code. Stubs in Tasks 1–2 are explicitly fleshed out in Tasks 3–6 (not left as placeholders).

**3. Consistency:** Types block matches the shipped endpoint shapes (GoalRow/PlayRow/FeedEntry). Admin-gating mirrors the API's own role checks. Verification model (build + manual) is stated up front because there's no frontend test runner.

**Known verification points for the implementer:** confirm whether `components/` exports are named or default (match `AiResponses.tsx`'s import style); confirm the `api()` import path (`../api`); confirm `useAuth` exposes `user.role`; the existing `ai-responses` (Jobix) page is left intact.
