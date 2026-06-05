# Call Actions — B1 (Actions Core, no sending) Design

**Date:** 2026-06-05
**Status:** Design approved (pending spec review)
**Scope:** B1 of 2 (Slice B of the Call Analytics Center). Tasks + resolution disposition + worklist. **No sending** (outbound comm / forward = B2).

---

## 0. Why

The Call Analytics Center lets a tenant *see* their calls (Slice A). B1 lets them *act* on a call's
outcome: open a **follow-up task** (e.g. Mafadi "log a maintenance request for unit 103, assign to
Maintenance"), track it to done, set the call's **resolution**, and work a cross-call **to-do
worklist**. This is the keystone of "store AND action the outcomes of calls."

`call_actions` is a **new table parallel to the shipped `call_handovers`** (First Assist/ABSA).
Handovers and the send pipeline are **not touched**. B1 introduces no sending at all.

## 0.1 Non-negotiable constraints

- **Additive / no regression:** new table, additive `call_facts.resolution_note` column, new routes.
  `call_handovers`, the send pipeline, line-reporting, and Slice A reads are untouched.
- **Role gating:** every new route is `tenant_admin` OR `super_admin` (no `tenant_user`), matching
  the rest of the Calls surface.
- **Full table defined once:** the migration defines the comm/forward columns too (reserved for B2)
  so B2 needs no migration.

---

## 1. Data model

### 1.1 Migration `1700000000031_call_actions.cjs`
`call_actions` (an action belongs to one call = one inbound `agent_messages` row):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `tenant_id` | uuid notNull → tenants | CASCADE |
| `message_id` | uuid notNull → agent_messages | CASCADE (the call) |
| `kind` | text notNull | check `IN ('task','comm','forward')` — **B1 creates only `task`** |
| `status` | text notNull default `'open'` | check `IN ('open','in_progress','done','cancelled','draft','pending_approval','approved','sent','rejected')` (task uses open/in_progress/done/cancelled; comm/forward use draft/pending_approval/approved/sent/rejected in B2) |
| `assignee_label` | text | team/department (reuses the `attribution_label` vocabulary) |
| `title` | text notNull default `''` | task title (comm subject in B2) |
| `body` | text notNull default `''` | task notes (message body in B2) |
| `due_at` | timestamptz | task due date |
| `created_by` | uuid → users (SET NULL) | |
| `channel` | text | **B2** (email/sms/whatsapp) — nullable, unused in B1 |
| `to_addr` | text | **B2** recipient — nullable, unused in B1 |
| `approved_by` | uuid → users (SET NULL) | **B2** |
| `approved_at` | timestamptz | **B2** |
| `sent_at` | timestamptz | **B2** |
| `email_id` | uuid | **B2** link to `emails` |
| `note` | text | free note attached on a status change (e.g. why cancelled/done) |
| `created_at` / `updated_at` | timestamptz default now() | |

Indexes: `(tenant_id, status, due_at)`, `(tenant_id, assignee_label)`, `(message_id)`.

Also: `pgm.addColumn('call_facts', { resolution_note: { type: 'text' } })` (nullable).

### 1.2 Resolution disposition is NOT a `call_actions` row
Setting a call's resolution updates **`call_facts`** directly: `resolution_state` (the existing
column), the new `resolution_note`, and the existing `resolved_at`/`resolved_by` (set when the
state becomes `resolved`/`unresolved`; cleared back to null when reopened to `open`/`in_progress`).

---

## 2. Repo

### 2.1 `server/src/repos/callActions.ts` (new)
- `createTask(pool, { tenantId, messageId, title, body?, assigneeLabel?, dueAt?, createdBy }) → CallActionRow`
  — inserts `kind='task', status='open'`. Validates the call (`message_id`) belongs to the tenant.
- `listActionsForCall(pool, tenantId, messageId) → CallActionRow[]` — drill-down (all kinds, newest first).
- `listWorklist(pool, tenantId, { status?, assigneeLabel?, kind?, dueBefore?, limit?, offset? }) → { actions: WorklistRow[]; total }`
  — cross-call. Default = open + in_progress tasks. `WorklistRow` joins the call's `summary_text`
  (`agent_messages.content`, truncated) + `attribution_label` for context.
- `updateAction(pool, tenantId, actionId, { status?, title?, body?, assigneeLabel?, dueAt?, note? }) → CallActionRow | null`
  — guarded status transitions for tasks: `open↔in_progress`, →`done`, →`cancelled`; rejects
  illegal jumps with a thrown error. Only updates fields provided. (B2 adds comm/forward transitions.)

`CallActionRow` mirrors the table columns.

### 2.2 `server/src/repos/callFacts.ts` (extend)
- `setResolution(pool, { tenantId, messageId, state, note, userId }) → void` — updates
  `resolution_state`, `resolution_note`; sets `resolved_at=now(), resolved_by=userId` when state ∈
  {resolved, unresolved}, else nulls them. Upserts a `call_facts` row if one doesn't exist yet
  (legacy calls), so resolution works on any inbound call.

---

## 3. Routes — `server/src/routes/callActions.ts` (new), registered in `app.ts`

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/calls/:id/actions` | Create a follow-up task on call `:id` (`title`, `assignee_label?`, `due_at?`, `body?`). |
| GET | `/api/calls/:id/actions` | List all actions for a call (drill-down). |
| PATCH | `/api/calls/actions/:actionId` | Update a task: status (mark in_progress/done/cancelled) and/or fields; optional `note`. |
| GET | `/api/calls/actions` | Worklist: cross-call actions, filters `status, assignee_label, kind, dueBefore`, pagination. Default open+in_progress tasks. |
| PUT | `/api/calls/:id/resolution` | Set `{ state, note? }` on the call → `setResolution`. |

All gated `tenant_admin`/`super_admin` (mirror `callAnalytics` routes' `requireAdmin(requireTenantCtx(req))`).
Zod-validated bodies; unknown enum/illegal transition → 400. `:id`/`:actionId` scoped to the
tenant (404 if not theirs) — no cross-tenant access.

---

## 4. Frontend — `web/src/pages/Calls.tsx` (+ `web/src/lib/calls.ts`)

### 4.1 lib
Types + calls: `CallAction`, `createTask`, `listCallActions(messageId)`, `updateAction(id, patch)`,
`listWorklist(filters)`, `setResolution(messageId, state, note)`. Same `api<T>()` pattern.

### 4.2 Drill-down modal (now read-write)
Slice A made the modal a read-only structured view. B1 adds, below the structured fields:
- **Resolution control:** a state dropdown (open/in_progress/resolved/unresolved) + a note field +
  Save → `PUT /api/calls/:id/resolution`. Reflects current `resolution_state`/`resolution_note`.
- **Tasks section:** list this call's tasks (title, assignee label, due, status chip) with controls
  to mark in_progress/done/cancel; and an **"Add task"** mini-form (title, assignee label dropdown
  sourced from known attribution labels + free entry, optional due date).

### 4.3 Worklist panel
A new **"To-dos"** panel/section on the Calls page: cross-call open tasks from `GET /api/calls/actions`,
with filters (team/assignee label, status, due-before), each row showing the task + its call's
snippet/department and a quick "Done" action; clicking the call snippet opens that call's drill-down.

Other panels (dashboard, grid, categories, ask-Abe, settings) unchanged.

## 5. Data flow

Human (admin) on a call → create task / set resolution (drill-down) → `call_actions` / `call_facts`
→ worklist reads `call_actions` across calls. No external delivery, no send pipeline. Pure CRUD +
one state update.

## 6. Error handling

- Illegal status transition or bad enum → 400 (guarded in repo + zod).
- Action/call not owned by tenant → 404.
- `setResolution` on a call with no `call_facts` row → upsert first (legacy calls).
- Empty worklist / no tasks → existing empty-state styling.

## 7. Testing (Vitest, serial, Neon test branch + web build)

- **Repo:** `createTask` inserts open task scoped to tenant+call; `listActionsForCall` returns them;
  `updateAction` allows open→in_progress→done and →cancelled, **rejects** illegal jumps; cross-tenant
  action update → no-op/null; `listWorklist` defaults to open+in_progress, honours filters, joins
  call context; `setResolution` sets state+note+resolved_by/at and clears them on reopen, upserts
  for a factless call.
- **Routes:** create/list/patch/worklist/resolution happy paths; role gate (non-admin → 403);
  cross-tenant `:id`/`:actionId` → 404; bad transition/enum → 400.
- **Non-breakage:** existing `callAnalytics.*`, `handover.*`, `lineReport.*`, email tests stay green;
  full suite green; strict `tsc`; web build passes.

## 8. Out of scope (B2 and beyond)

- Outbound comm (email-via-pipeline + SMS/WA draft) and forward/escalate, with the structural
  send-gate. (Their columns exist in the table but are unused in B1.)
- Surfacing `call_handovers` read-only in the worklist.
- Abe auto-suggesting actions; per-user assignment; notifications/reminders; SLA timers.
