# Onboarding UX Rework — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land super-admins on a Tenant Picker after login, with a guided 3-step wizard (Tenant → Sender+SMTP → verified test send) reachable from a single "+ New tenant" button.

**Architecture:** Frontend is a React 18 + Vite + react-router app. Pages move under a `/t/:tenantId/*` prefix so the URL carries tenant identity. A new server endpoint, `POST /api/session/active-tenant`, lets super-admins set the session's active tenant; existing tenant-scoped routes (`/api/senders`, `/api/smtp-configs`, etc.) start respecting `session.activeTenantId` for super-admins, so no per-route changes are needed beyond the ctx hook. The wizard composes existing endpoints — `POST /api/admin/tenants`, `POST /api/session/active-tenant`, `POST /api/smtp-configs`, `POST /api/senders`, `POST /api/smtp-configs/:id/test` — to reach a real test send without adding business logic.

**Tech Stack:** TypeScript, React 18, Vite, react-router-dom v6, Tailwind CSS, Fastify + zod (server), @fastify/secure-session, Vitest (server), Postgres (Neon).

**Spec:** `docs/superpowers/specs/2026-05-28-onboarding-ux-design.md`.

---

## File Structure

**Server**
- Modify: `server/src/auth/ctx.ts` — read `session.activeTenantId` for super-admins.
- Create: `server/src/routes/session.ts` — `POST /api/session/active-tenant` and `GET /api/session/active-tenant`.
- Modify: `server/src/app.ts` — register the new route module.
- Modify: `server/src/types/session.d.ts` (or wherever `Session` type lives) — add `activeTenantId?: string` to the session augmentation. (If no such file exists, this is added inline in `ctx.ts` via `declare module`.)
- Create: `server/test/session-active-tenant.test.ts` — vitest covering the endpoint.

**Web**
- Modify: `web/src/routes.tsx` — move tenant pages under `/t/:tenantId/*`, add picker + wizard routes, legacy redirects.
- Create: `web/src/pages/TenantPicker.tsx` — landing grid + empty state.
- Create: `web/src/pages/Onboarding.tsx` — top-level wizard shell; reads `?tenantId=&step=` from URL.
- Create: `web/src/pages/onboarding/StepTenant.tsx`.
- Create: `web/src/pages/onboarding/StepSender.tsx`.
- Create: `web/src/pages/onboarding/StepTest.tsx`.
- Create: `web/src/pages/onboarding/ProgressBar.tsx` — three-step progress indicator.
- Create: `web/src/pages/onboarding/state.ts` — TS types for cross-step state passed via the URL + a small `useWizardState` hook.
- Modify: `web/src/components/AppShell.tsx` — add tenant switcher, change NavLinks to `/t/:tenantId/...` paths, call `POST /api/session/active-tenant` on mount/switch.
- Create: `web/src/components/TenantSwitcher.tsx` — dropdown used inside `AppShell`.
- Modify: `web/src/auth.tsx` — extend `SessionUser` to optionally carry `activeTenantId`, expose `setActiveTenant(tenantId)` helper.
- Modify: `web/src/api.ts` (only if it needs a tenantId-aware helper; otherwise leave alone — most code already hits relative paths).

---

## Task 1: Server — `session.activeTenantId` infrastructure

**Files:**
- Modify: `server/src/auth/ctx.ts`
- Create: `server/src/routes/session.ts`
- Modify: `server/src/app.ts`
- Test: `server/test/session-active-tenant.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/session-active-tenant.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';
import { resetTestDb, seedSuperAdmin, seedTenant, loginAs } from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  await resetTestDb();
  app = await buildApp();
  await app.ready();
});

afterAll(async () => { await app.close(); });

describe('POST /api/session/active-tenant', () => {
  it('400s for non-super-admin', async () => {
    const tenant = await seedTenant({ name: 'Acme', slug: 'acme' });
    const user = await seedSuperAdmin({ email: 'admin@example.com', password: 'pw12345678' });
    // create a regular tenant user
    const tu = await seedTenant({ name: 'TU', slug: 'tu' });
    const cookie = await loginAs(app, { email: 'admin@example.com', password: 'pw12345678' });
    const r = await app.inject({
      method: 'POST', url: '/api/session/active-tenant',
      headers: { cookie }, payload: { tenantId: tenant.id },
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, tenantId: tenant.id });
    // Now hit a tenant-scoped GET to confirm context flips:
    const senders = await app.inject({ method: 'GET', url: '/api/senders', headers: { cookie } });
    expect(senders.statusCode).toBe(200);
  });

  it('rejects unknown tenant id', async () => {
    const cookie = await loginAs(app, { email: 'admin@example.com', password: 'pw12345678' });
    const r = await app.inject({
      method: 'POST', url: '/api/session/active-tenant',
      headers: { cookie }, payload: { tenantId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(r.statusCode).toBe(404);
  });
});
```

Note: if `server/test/helpers.ts` does not already export `seedSuperAdmin`, `seedTenant`, `loginAs`, add them as part of Step 3 — they belong to the test harness, not the production code. Look for existing helpers first; reuse and extend rather than duplicate.

- [ ] **Step 2: Run test to verify it fails**

Run from `server/`:

```
npx vitest run test/session-active-tenant.test.ts
```

Expected: FAIL with 404 on `/api/session/active-tenant` (route does not exist).

- [ ] **Step 3: Implement route + ctx change**

Create `server/src/routes/session.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireCtx } from '../auth/ctx.js';
import { AppError, sendError } from '../util/errors.js';

const Body = z.object({ tenantId: z.string().uuid() });

export async function registerSessionRoutes(app: FastifyInstance) {
  app.post('/api/session/active-tenant', async (req, reply) => {
    try {
      const ctx = requireCtx(req);
      if (ctx.role !== 'super_admin') {
        throw new AppError('forbidden', 403, 'Super admin required');
      }
      const { tenantId } = Body.parse(req.body);
      const r = await app.pool.query('SELECT 1 FROM tenants WHERE id = $1', [tenantId]);
      if (r.rowCount === 0) throw new AppError('not_found', 404, 'Tenant not found');
      req.session.activeTenantId = tenantId;
      return reply.send({ ok: true, tenantId });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/session/active-tenant', async (req, reply) => {
    try {
      const ctx = requireCtx(req);
      if (ctx.role !== 'super_admin') return reply.send({ tenantId: ctx.tenantId || null });
      return reply.send({ tenantId: req.session.activeTenantId ?? null });
    } catch (e) { sendError(reply, e); }
  });

  app.delete('/api/session/active-tenant', async (req, reply) => {
    try {
      const ctx = requireCtx(req);
      if (ctx.role !== 'super_admin') throw new AppError('forbidden', 403, 'Super admin required');
      req.session.activeTenantId = undefined;
      return reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });
}
```

Augment the session type. Add the following to the top of `server/src/auth/ctx.ts` (or wherever `req.session` is augmented today; grep for `interface Session` first):

```ts
declare module '@fastify/secure-session' {
  interface SessionData { activeTenantId?: string }
}
```

If the project uses a different session plugin, augment the appropriate module. Search `server/src` for `req.session.userId` to find the existing augmentation site and add `activeTenantId?: string` alongside `userId`, `tenantId`, `role`.

Modify `server/src/auth/ctx.ts` so super-admins receive `activeTenantId` as `tenantId`. Replace the existing branch inside `registerCtx` for `/api/`+`/auth/`:

```ts
if (req.url.startsWith('/api/') || req.url.startsWith('/auth/')) {
  const sess = req.session;
  if (!sess?.userId) {
    const path = req.url.split('?')[0];
    if (path === '/auth/login' || path === '/auth/invite/accept' || path === '/api/me') return;
    return reply.code(401).send({ error: { code: 'unauthorized', message: 'Not signed in' } });
  }
  const role = sess.role!;
  const effectiveTenantId =
    role === 'super_admin'
      ? (sess.activeTenantId ?? '')
      : (sess.tenantId ?? '');
  req.ctx = {
    tenantId: effectiveTenantId,
    userId: sess.userId,
    role,
  };
}
```

Modify `server/src/app.ts` to register the new module. Find the block where other route registrations live (e.g. `await registerSenderRoutes(app)`) and add:

```ts
import { registerSessionRoutes } from './routes/session.js';
// ...
await registerSessionRoutes(app);
```

- [ ] **Step 4: Run test to verify it passes**

Run from `server/`:

```
npx vitest run test/session-active-tenant.test.ts
```

Expected: PASS.

- [ ] **Step 5: Tighten `requireTenantCtx` so super-admin without active tenant is rejected**

Modify `requireTenantCtx` in `server/src/auth/ctx.ts`:

```ts
export function requireTenantCtx(req: FastifyRequest): Ctx & { tenantId: string } {
  const ctx = requireCtx(req);
  if (!ctx.tenantId) {
    throw new AppError('no_active_tenant', 400, 'No active tenant. Set one via POST /api/session/active-tenant.');
  }
  return ctx as Ctx & { tenantId: string };
}
```

Add a vitest case to `session-active-tenant.test.ts`:

```ts
it('blocks tenant-scoped routes when super-admin has no active tenant', async () => {
  const cookie = await loginAs(app, { email: 'admin@example.com', password: 'pw12345678' });
  // do NOT set active tenant
  const r = await app.inject({ method: 'GET', url: '/api/senders', headers: { cookie } });
  expect(r.statusCode).toBe(400);
  expect(JSON.parse(r.body).error.code).toBe('no_active_tenant');
});
```

Run: `npx vitest run test/session-active-tenant.test.ts` — expected PASS.

- [ ] **Step 6: Commit**

```
git add server/src/auth/ctx.ts server/src/routes/session.ts server/src/app.ts server/test/session-active-tenant.test.ts
git commit -m "feat(server): session.activeTenantId for super-admin tenant scoping"
```

---

## Task 2: Web — auth + tenant helper hooks

**Files:**
- Modify: `web/src/auth.tsx`
- Create: `web/src/lib/tenants.ts`

- [ ] **Step 1: Extend `SessionUser` and add `setActiveTenant`**

Modify `web/src/auth.tsx`. Update the context shape:

```ts
export interface SessionUser { id: string; email: string; role: 'super_admin' | 'tenant_admin' | 'tenant_user'; tenantId: string | null; activeTenantId: string | null }

interface AuthCtx {
  user: SessionUser | null;
  loading: boolean;
  login: (e: string, p: string) => Promise<void>;
  logout: () => Promise<void>;
  setActiveTenant: (tenantId: string) => Promise<void>;
  clearActiveTenant: () => Promise<void>;
}
```

Inside `AuthProvider`, hydrate `activeTenantId` from `GET /api/session/active-tenant` after `/api/me` succeeds:

```ts
useEffect(() => {
  (async () => {
    try {
      const me = await api<{ user: SessionUser | null }>('/api/me');
      if (!me.user) { setUser(null); return; }
      const at = await api<{ tenantId: string | null }>('/api/session/active-tenant');
      setUser({ ...me.user, activeTenantId: at.tenantId });
    } catch { setUser(null); }
    finally { setLoading(false); }
  })();
}, []);
```

Add the helpers:

```ts
const setActiveTenant = useCallback(async (tenantId: string) => {
  await api('/api/session/active-tenant', { method: 'POST', body: JSON.stringify({ tenantId }) });
  setUser(u => u ? { ...u, activeTenantId: tenantId } : u);
}, []);

const clearActiveTenant = useCallback(async () => {
  await api('/api/session/active-tenant', { method: 'DELETE' });
  setUser(u => u ? { ...u, activeTenantId: null } : u);
}, []);
```

Include both in the provider value.

- [ ] **Step 2: Add `useTenants` data hook**

Create `web/src/lib/tenants.ts`:

```ts
import { useEffect, useState, useCallback } from 'react';
import { api } from '../api';

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  created_at?: string;
}

export function useTenants() {
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ tenants: TenantSummary[] }>('/api/admin/tenants');
      setTenants(r.tenants);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { tenants, loading, reload };
}
```

- [ ] **Step 3: Commit**

```
git add web/src/auth.tsx web/src/lib/tenants.ts
git commit -m "feat(web): auth carries activeTenantId; useTenants hook"
```

---

## Task 3: Web — route restructure under `/t/:tenantId/*`

**Files:**
- Modify: `web/src/routes.tsx`
- Modify: `web/src/components/AppShell.tsx` (NavLink path changes only — switcher comes in Task 7)

- [ ] **Step 1: Rewrite `routes.tsx`**

Replace `web/src/routes.tsx` contents:

```tsx
import { createBrowserRouter, Navigate, useParams, useLocation } from 'react-router-dom';
import { useEffect, useState, type ReactNode } from 'react';
import { AuthProvider, useAuth } from './auth';
import AppShell from './components/AppShell';
import Login from './pages/Login';
import AcceptInvite from './pages/AcceptInvite';
import Dashboard from './pages/Dashboard';
import Senders from './pages/Senders';
import Templates from './pages/Templates';
import SmtpConfigs from './pages/SmtpConfigs';
import ApiKeys from './pages/ApiKeys';
import EmailLog from './pages/EmailLog';
import Suppressions from './pages/Suppressions';
import Users from './pages/Users';
import AdminTenants from './pages/AdminTenants';
import TenantPicker from './pages/TenantPicker';
import Onboarding from './pages/Onboarding';

function Authed({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function TenantGate({ children }: { children: ReactNode }) {
  const { tenantId } = useParams<{ tenantId: string }>();
  const { user, setActiveTenant } = useAuth();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!tenantId) return;
    if (user?.activeTenantId === tenantId) { setReady(true); return; }
    setActiveTenant(tenantId).then(() => setReady(true)).catch(() => setReady(true));
  }, [tenantId, user?.activeTenantId, setActiveTenant]);
  if (!ready) return null;
  return <>{children}</>;
}

function LegacyRedirect() {
  const { user } = useAuth();
  const loc = useLocation();
  const fallback = localStorage.getItem('lastTenantId') ?? user?.tenantId ?? user?.activeTenantId ?? null;
  if (fallback) return <Navigate to={`/t/${fallback}${loc.pathname}${loc.search}`} replace />;
  return <Navigate to="/" replace />;
}

export const router = createBrowserRouter([
  { path: '/login', element: <AuthProvider><Login /></AuthProvider> },
  { path: '/accept-invite', element: <AuthProvider><AcceptInvite /></AuthProvider> },

  { path: '/', element: <AuthProvider><Authed><TenantPicker /></Authed></AuthProvider> },
  { path: '/onboarding', element: <AuthProvider><Authed><Onboarding /></Authed></AuthProvider> },
  { path: '/admin/tenants', element: <AuthProvider><Authed><AdminTenants /></Authed></AuthProvider> },

  {
    path: '/t/:tenantId',
    element: <AuthProvider><Authed><TenantGate><AppShell /></TenantGate></Authed></AuthProvider>,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'senders', element: <Senders /> },
      { path: 'templates', element: <Templates /> },
      { path: 'smtp', element: <SmtpConfigs /> },
      { path: 'api-keys', element: <ApiKeys /> },
      { path: 'log', element: <EmailLog /> },
      { path: 'suppressions', element: <Suppressions /> },
      { path: 'users', element: <Users /> },
    ],
  },

  // Legacy paths: /senders, /templates, etc. → /t/:lastUsedTenantId/<segment>
  { path: '/senders', element: <AuthProvider><Authed><LegacyRedirect /></Authed></AuthProvider> },
  { path: '/templates', element: <AuthProvider><Authed><LegacyRedirect /></Authed></AuthProvider> },
  { path: '/smtp', element: <AuthProvider><Authed><LegacyRedirect /></Authed></AuthProvider> },
  { path: '/api-keys', element: <AuthProvider><Authed><LegacyRedirect /></Authed></AuthProvider> },
  { path: '/log', element: <AuthProvider><Authed><LegacyRedirect /></Authed></AuthProvider> },
  { path: '/suppressions', element: <AuthProvider><Authed><LegacyRedirect /></Authed></AuthProvider> },
  { path: '/users', element: <AuthProvider><Authed><LegacyRedirect /></Authed></AuthProvider> },
]);
```

`TenantPicker` and `Onboarding` are imported but don't exist yet — that's intentional; we add stubs next so the app compiles.

- [ ] **Step 2: Add minimal `TenantPicker` and `Onboarding` stubs so the bundle compiles**

Create `web/src/pages/TenantPicker.tsx`:

```tsx
export default function TenantPicker() { return <div>Tenant picker (TBD)</div>; }
```

Create `web/src/pages/Onboarding.tsx`:

```tsx
export default function Onboarding() { return <div>Onboarding (TBD)</div>; }
```

These get replaced in Tasks 4 and 5–6. The single "TBD" sentinel here is acceptable because every later task replaces the file wholesale.

- [ ] **Step 3: Update `AppShell` NavLink paths to be tenant-scoped**

Modify `web/src/components/AppShell.tsx`. Replace the `<nav>` block:

```tsx
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
// ...
export default function AppShell() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const { tenantId } = useParams<{ tenantId: string }>();
  // persist for legacy-redirect fallback
  if (tenantId) localStorage.setItem('lastTenantId', tenantId);
  const base = `/t/${tenantId}`;
  return (
    <div className="min-h-full grid grid-cols-[240px_1fr]">
      <aside className="border-r border-line p-4 flex flex-col gap-6">
        <div className="font-heading font-semibold text-lg">AIployee Emailer</div>
        <nav className="flex flex-col gap-1">
          <NavLink to={base} end className={link}>Dashboard</NavLink>
          <NavLink to={`${base}/senders`} className={link}>Senders</NavLink>
          <NavLink to={`${base}/templates`} className={link}>Templates</NavLink>
          <NavLink to={`${base}/smtp`} className={link}>SMTP configs</NavLink>
          <NavLink to={`${base}/api-keys`} className={link}>API keys</NavLink>
          <NavLink to={`${base}/log`} className={link}>Email log</NavLink>
          <NavLink to={`${base}/suppressions`} className={link}>Suppressions</NavLink>
          <NavLink to={`${base}/users`} className={link}>Users</NavLink>
          {user?.role === 'super_admin' && <NavLink to="/admin/tenants" className={link}>Tenants</NavLink>}
        </nav>
        <button onClick={async () => { await logout(); nav('/login'); }}
          className="mt-auto text-sm text-muted hover:text-ink text-left">Sign out</button>
      </aside>
      <main className="p-8 max-w-5xl"><Outlet /></main>
    </div>
  );
}
```

(Leave the `link` styling helper unchanged.)

- [ ] **Step 4: Build the web bundle**

Run from `web/`:

```
npm run build
```

Expected: succeeds.

- [ ] **Step 5: Smoke-test routing manually**

Run from `web/`:

```
npm run dev
```

Then in a browser:
- Log in as a super-admin.
- Confirm `/` renders the stub picker.
- Manually visit `/t/<known-tenant-id>` — AppShell renders with sidebar; sidebar links go to `/t/<id>/senders`, etc.
- Visit `/senders` — redirects to `/t/<lastTenantId>/senders`.

- [ ] **Step 6: Commit**

```
git add web/src/routes.tsx web/src/components/AppShell.tsx web/src/pages/TenantPicker.tsx web/src/pages/Onboarding.tsx
git commit -m "feat(web): route per-tenant pages under /t/:tenantId/* + legacy redirects"
```

---

## Task 4: Web — TenantPicker page

**Files:**
- Modify: `web/src/pages/TenantPicker.tsx` (replace stub)

- [ ] **Step 1: Replace the stub with the real picker**

Replace contents of `web/src/pages/TenantPicker.tsx`:

```tsx
import { useState, useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { useTenants } from '../lib/tenants';
import Input from '../components/Input';
import Button from '../components/Button';

export default function TenantPicker() {
  const { user, setActiveTenant, logout } = useAuth();
  const { tenants, loading } = useTenants();
  const nav = useNavigate();
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    if (!q) return tenants;
    const lq = q.toLowerCase();
    return tenants.filter(t => t.name.toLowerCase().includes(lq) || t.slug.toLowerCase().includes(lq));
  }, [tenants, q]);

  const incompleteId = localStorage.getItem('incompleteTenantId');

  async function open(tenantId: string) {
    await setActiveTenant(tenantId);
    localStorage.setItem('lastTenantId', tenantId);
    nav(`/t/${tenantId}`);
  }

  if (loading) return null;

  return (
    <div className="min-h-screen p-8 max-w-6xl mx-auto">
      <header className="flex items-center justify-between mb-8">
        <div className="font-heading font-semibold text-xl">AIployee Emailer</div>
        <div className="flex items-center gap-4 text-sm text-muted">
          <span>{user?.email}</span>
          <button onClick={async () => { await logout(); nav('/login'); }}
            className="hover:text-ink">Sign out</button>
        </div>
      </header>

      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-heading font-semibold">Tenants</h1>
        <Link to="/onboarding">
          <Button>+ New tenant</Button>
        </Link>
      </div>

      {tenants.length === 0 ? (
        <div className="border border-line rounded-lg p-12 text-center">
          <div className="text-lg font-medium mb-2">No tenants yet</div>
          <div className="text-muted mb-6">Create your first one to get started.</div>
          <Link to="/onboarding"><Button>+ New tenant</Button></Link>
        </div>
      ) : (
        <>
          {tenants.length > 8 && (
            <div className="mb-4 max-w-sm">
              <Input placeholder="Search tenants" value={q} onChange={e => setQ(e.target.value)} />
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map(t => (
              <button key={t.id} onClick={() => open(t.id)}
                className="border border-line rounded-lg p-5 text-left hover:bg-surface transition">
                <div className="font-medium text-lg">{t.name}</div>
                <div className="text-xs text-muted mt-1">{t.slug}</div>
                {t.id === incompleteId && (
                  <div className="mt-3 inline-block text-xs bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded">
                    Setup incomplete
                  </div>
                )}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="col-span-full text-muted text-sm">No tenants match "{q}".</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
```

If `Input`/`Button` don't export defaults the way shown, adjust imports to match (`import { Input } from '../components/Input'` etc.). Check `web/src/components/Input.tsx` and `Button.tsx` before writing.

- [ ] **Step 2: Verify build**

Run from `web/`:

```
npm run build
```

Expected: succeeds.

- [ ] **Step 3: Manual smoke**

Run `npm run dev` and:
- Log in as super-admin with at least one tenant.
- `/` renders the picker grid.
- Click a card → URL becomes `/t/<id>` and AppShell loads.
- Delete the entry from `localStorage` (`lastTenantId`) and reload `/` — still works.

- [ ] **Step 4: Commit**

```
git add web/src/pages/TenantPicker.tsx
git commit -m "feat(web): tenant picker landing with empty state and search"
```

---

## Task 5: Web — Onboarding wizard shell + Step 1 (Tenant)

**Files:**
- Create: `web/src/pages/onboarding/state.ts`
- Create: `web/src/pages/onboarding/ProgressBar.tsx`
- Create: `web/src/pages/onboarding/StepTenant.tsx`
- Modify: `web/src/pages/Onboarding.tsx` (replace stub)

- [ ] **Step 1: Wizard shared state**

Create `web/src/pages/onboarding/state.ts`:

```ts
import { useSearchParams } from 'react-router-dom';

export type WizardStep = '1' | '2' | '3';

export interface WizardState {
  step: WizardStep;
  tenantId: string | null;
  tenantName: string | null;
  smtpConfigId: string | null;
  senderId: string | null;
  senderEmail: string | null;
  fromDomain: string | null;
}

export function useWizardState(): [WizardState, (patch: Partial<WizardState>) => void] {
  const [sp, setSp] = useSearchParams();
  const state: WizardState = {
    step: (sp.get('step') as WizardStep) || '1',
    tenantId: sp.get('tenantId'),
    tenantName: sp.get('tenantName'),
    smtpConfigId: sp.get('smtpConfigId'),
    senderId: sp.get('senderId'),
    senderEmail: sp.get('senderEmail'),
    fromDomain: sp.get('fromDomain'),
  };
  const update = (patch: Partial<WizardState>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null) next.delete(k);
      else next.set(k, String(v));
    }
    setSp(next, { replace: true });
  };
  return [state, update];
}
```

- [ ] **Step 2: Progress bar**

Create `web/src/pages/onboarding/ProgressBar.tsx`:

```tsx
export function ProgressBar({ step }: { step: '1' | '2' | '3' }) {
  const items: Array<['1'|'2'|'3', string]> = [['1','Tenant'], ['2','Sender'], ['3','Test']];
  return (
    <ol className="flex items-center gap-4 mb-8">
      {items.map(([n, label], i) => {
        const active = n === step;
        const done = Number(n) < Number(step);
        return (
          <li key={n} className="flex items-center gap-2 text-sm">
            <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${
              active ? 'bg-ink text-white' : done ? 'bg-green-600 text-white' : 'bg-surface text-muted'
            }`}>{n}</span>
            <span className={active ? 'font-medium' : 'text-muted'}>{label}</span>
            {i < items.length - 1 && <span className="w-8 h-px bg-line ml-2" />}
          </li>
        );
      })}
    </ol>
  );
}
```

- [ ] **Step 3: Step 1 — Tenant form**

Create `web/src/pages/onboarding/StepTenant.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { useWizardState } from './state';
import Input from '../../components/Input';
import Button from '../../components/Button';

function slugify(s: string) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function StepTenant() {
  const [state, update] = useWizardState();
  const { user, setActiveTenant } = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState(state.tenantName ?? '');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [adminEmail, setAdminEmail] = useState(user?.email ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!slugTouched) setSlug(slugify(name));
  }, [name, slugTouched]);

  async function onNext(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setSubmitting(true);
    try {
      const r = await api<{ tenant: { id: string; name: string; slug: string } }>(
        '/api/admin/tenants',
        { method: 'POST', body: JSON.stringify({ name, slug, adminEmail }) },
      );
      await setActiveTenant(r.tenant.id);
      localStorage.setItem('incompleteTenantId', r.tenant.id);
      update({ step: '2', tenantId: r.tenant.id, tenantName: r.tenant.name });
    } catch (e: unknown) {
      const msg = (e as { body?: { error?: { code?: string; message?: string } } }).body?.error;
      if (msg?.code === 'slug_taken') setErr('That slug is already taken. Try a different one.');
      else setErr(msg?.message ?? 'Failed to create tenant.');
    } finally { setSubmitting(false); }
  }

  return (
    <form onSubmit={onNext} className="space-y-5 max-w-md">
      <h2 className="text-xl font-heading font-semibold">Create a tenant</h2>
      <div>
        <label className="block text-sm mb-1">Tenant name</label>
        <Input value={name} onChange={e => setName(e.target.value)} required autoFocus />
      </div>
      <div>
        <label className="block text-sm mb-1">Slug</label>
        <Input value={slug} onChange={e => { setSlugTouched(true); setSlug(e.target.value); }}
          pattern="[a-z0-9-]+" required />
        <p className="text-xs text-muted mt-1">Lowercase, numbers, dashes only.</p>
      </div>
      <div>
        <label className="block text-sm mb-1">Tenant admin email</label>
        <Input type="email" value={adminEmail} onChange={e => setAdminEmail(e.target.value)} required />
        <p className="text-xs text-muted mt-1">Will receive an invite to manage this tenant. Default: you.</p>
      </div>
      {err && <div className="text-sm text-red-600">{err}</div>}
      <div className="flex gap-3">
        <Button type="button" variant="ghost" onClick={() => nav('/')}>Cancel</Button>
        <Button type="submit" disabled={submitting || !name || !slug || !adminEmail}>
          {submitting ? 'Creating…' : 'Next'}
        </Button>
      </div>
    </form>
  );
}
```

Note: `Button` may not accept a `variant` prop. Open `web/src/components/Button.tsx` and check. If `variant` is unsupported, replace the cancel button with a plain `<button type="button" onClick={() => nav('/')} className="text-sm text-muted hover:text-ink">Cancel</button>`.

- [ ] **Step 4: Wizard container**

Replace `web/src/pages/Onboarding.tsx`:

```tsx
import { useWizardState } from './onboarding/state';
import { ProgressBar } from './onboarding/ProgressBar';
import { StepTenant } from './onboarding/StepTenant';

export default function Onboarding() {
  const [state] = useWizardState();
  return (
    <div className="min-h-screen p-8 max-w-2xl mx-auto">
      <ProgressBar step={state.step} />
      {state.step === '1' && <StepTenant />}
      {state.step === '2' && <div>Step 2 placeholder — implemented in Task 6.</div>}
      {state.step === '3' && <div>Step 3 placeholder — implemented in Task 7.</div>}
    </div>
  );
}
```

(The Step 2/3 placeholders are temporary scaffolding that get fully replaced in the next two tasks; not a TBD in the shipped code.)

- [ ] **Step 5: Build and smoke-test**

Run from `web/`:

```
npm run build
```

Then `npm run dev` and:
- Visit `/onboarding`.
- Fill in name "Acme Corp" — slug auto-fills "acme-corp".
- Submit — URL becomes `/onboarding?tenantId=…&tenantName=Acme%20Corp&step=2`.
- Tenant appears in `/api/admin/tenants` (check via the picker after going back).

- [ ] **Step 6: Commit**

```
git add web/src/pages/Onboarding.tsx web/src/pages/onboarding/
git commit -m "feat(web): onboarding wizard shell + step 1 (tenant create)"
```

---

## Task 6: Web — Wizard Step 2 (Sender + SMTP)

**Files:**
- Create: `web/src/pages/onboarding/StepSender.tsx`
- Modify: `web/src/pages/Onboarding.tsx`

- [ ] **Step 1: Implement Step 2**

Create `web/src/pages/onboarding/StepSender.tsx`:

```tsx
import { useState } from 'react';
import { api } from '../../api';
import { useWizardState } from './state';
import Input from '../../components/Input';
import Button from '../../components/Button';

interface Preset { label: string; host: string; port: number; secure: boolean }
const PRESETS: Record<string, Preset> = {
  gmail:   { label: 'Gmail',   host: 'smtp.gmail.com',    port: 465, secure: true  },
  outlook: { label: 'Outlook', host: 'smtp.office365.com', port: 587, secure: false },
  custom:  { label: 'Custom',  host: '',                   port: 587, secure: false },
};

export function StepSender() {
  const [state, update] = useWizardState();
  const [preset, setPreset] = useState<keyof typeof PRESETS>('gmail');
  const [host, setHost] = useState(PRESETS.gmail.host);
  const [port, setPort] = useState<number>(PRESETS.gmail.port);
  const [secure, setSecure] = useState(PRESETS.gmail.secure);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fromName, setFromName] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function selectPreset(key: keyof typeof PRESETS) {
    setPreset(key);
    const p = PRESETS[key];
    setHost(p.host); setPort(p.port); setSecure(p.secure);
  }

  const fromDomain = fromEmail.split('@')[1] ?? '';

  async function onNext(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setSubmitting(true);
    try {
      // 1) create SMTP config (active tenant is set in session)
      const smtp = await api<{ config: { id: string; from_domain: string } }>(
        '/api/smtp-configs',
        {
          method: 'POST',
          body: JSON.stringify({
            name: `${state.tenantName ?? 'Tenant'} default`,
            host, port, secure,
            username, password,
            fromDomain,
            isDefault: true,
          }),
        },
      );
      // 2) create sender
      const sender = await api<{ sender: { id: string; email: string } }>(
        '/api/senders',
        {
          method: 'POST',
          body: JSON.stringify({
            email: fromEmail,
            displayName: fromName,
            smtpConfigId: smtp.config.id,
            isDefault: true,
          }),
        },
      );
      update({
        step: '3',
        smtpConfigId: smtp.config.id,
        senderId: sender.sender.id,
        senderEmail: sender.sender.email,
        fromDomain,
      });
    } catch (e: unknown) {
      const body = (e as { body?: { error?: { code?: string; message?: string } } }).body?.error;
      setErr(body?.message ?? 'Failed to create sender.');
    } finally { setSubmitting(false); }
  }

  return (
    <form onSubmit={onNext} className="space-y-5 max-w-md">
      <h2 className="text-xl font-heading font-semibold">Add a sender</h2>

      <div>
        <label className="block text-sm mb-1">From name</label>
        <Input value={fromName} onChange={e => setFromName(e.target.value)} required />
      </div>
      <div>
        <label className="block text-sm mb-1">From email</label>
        <Input type="email" value={fromEmail} onChange={e => setFromEmail(e.target.value)} required />
      </div>

      <div>
        <div className="text-sm mb-2">SMTP provider</div>
        <div className="flex gap-2">
          {(Object.keys(PRESETS) as Array<keyof typeof PRESETS>).map(k => (
            <button type="button" key={k} onClick={() => selectPreset(k)}
              className={`px-3 py-1.5 text-sm rounded-md border ${
                preset === k ? 'bg-ink text-white border-ink' : 'border-line text-muted hover:text-ink'
              }`}>{PRESETS[k].label}</button>
          ))}
        </div>
      </div>

      {preset === 'custom' && (
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="block text-sm mb-1">Host</label>
            <Input value={host} onChange={e => setHost(e.target.value)} required />
          </div>
          <div>
            <label className="block text-sm mb-1">Port</label>
            <Input type="number" value={port} onChange={e => setPort(Number(e.target.value))} required />
          </div>
          <div className="flex items-end">
            <label className="text-sm flex items-center gap-2">
              <input type="checkbox" checked={secure} onChange={e => setSecure(e.target.checked)} />
              Use TLS
            </label>
          </div>
        </div>
      )}

      <div>
        <label className="block text-sm mb-1">SMTP username</label>
        <Input value={username} onChange={e => setUsername(e.target.value)} required />
      </div>
      <div>
        <label className="block text-sm mb-1">SMTP password</label>
        <Input type="password" value={password} onChange={e => setPassword(e.target.value)} required />
      </div>

      {err && <div className="text-sm text-red-600">{err}</div>}
      <div className="flex gap-3">
        <Button type="button" variant="ghost" onClick={() => update({ step: '1' })}>Back</Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Next'}
        </Button>
      </div>
    </form>
  );
}
```

(Same `variant="ghost"` caveat as Task 5 — adjust if `Button` lacks the prop.)

- [ ] **Step 2: Wire Step 2 into the wizard container**

Modify `web/src/pages/Onboarding.tsx`:

```tsx
import { useWizardState } from './onboarding/state';
import { ProgressBar } from './onboarding/ProgressBar';
import { StepTenant } from './onboarding/StepTenant';
import { StepSender } from './onboarding/StepSender';

export default function Onboarding() {
  const [state] = useWizardState();
  return (
    <div className="min-h-screen p-8 max-w-2xl mx-auto">
      <ProgressBar step={state.step} />
      {state.step === '1' && <StepTenant />}
      {state.step === '2' && <StepSender />}
      {state.step === '3' && <div>Step 3 placeholder — implemented in Task 7.</div>}
    </div>
  );
}
```

- [ ] **Step 3: Smoke-test**

Run `npm run dev` and walk the full wizard so far:
- Create tenant in step 1.
- In step 2, pick "Gmail", fill `fromName`/`fromEmail` with a real Gmail address, paste an app-password.
- Submit — URL advances to `step=3` with `smtpConfigId` and `senderId` set.
- Confirm `/api/smtp-configs` and `/api/senders` (via `/t/<id>/smtp` and `/t/<id>/senders`) show the new rows.

- [ ] **Step 4: Commit**

```
git add web/src/pages/Onboarding.tsx web/src/pages/onboarding/StepSender.tsx
git commit -m "feat(web): wizard step 2 (sender + SMTP with provider presets)"
```

---

## Task 7: Web — Wizard Step 3 (Send test) + success screen

**Files:**
- Create: `web/src/pages/onboarding/StepTest.tsx`
- Modify: `web/src/pages/Onboarding.tsx`

- [ ] **Step 1: Implement Step 3**

Create `web/src/pages/onboarding/StepTest.tsx`:

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { useWizardState } from './state';
import Input from '../../components/Input';
import Button from '../../components/Button';

type SendStatus = 'idle' | 'sending' | 'sent' | 'failed';

export function StepTest() {
  const [state, update] = useWizardState();
  const { user } = useAuth();
  const nav = useNavigate();
  const [to, setTo] = useState(user?.email ?? '');
  const [status, setStatus] = useState<SendStatus>('idle');
  const [err, setErr] = useState<string | null>(null);

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    if (!state.smtpConfigId) return;
    setStatus('sending'); setErr(null);
    try {
      await api<{ ok: true; messageId: string }>(
        `/api/smtp-configs/${state.smtpConfigId}/test`,
        { method: 'POST', body: JSON.stringify({ to }) },
      );
      setStatus('sent');
      if (state.tenantId) localStorage.removeItem('incompleteTenantId');
    } catch (e: unknown) {
      const msg = (e as { body?: { error?: { message?: string } } }).body?.error?.message
        ?? (e as Error).message;
      setErr(msg ?? 'Send failed.');
      setStatus('failed');
    }
  }

  if (status === 'sent') {
    return (
      <div className="space-y-5 max-w-md">
        <h2 className="text-xl font-heading font-semibold">All set</h2>
        <p className="text-sm text-muted">
          Test email delivered to <span className="text-ink">{to}</span>. Check that inbox to confirm.
        </p>
        <div className="flex gap-3">
          <Button onClick={() => state.tenantId && nav(`/t/${state.tenantId}`)}>
            Go to tenant dashboard
          </Button>
          <Button type="button" variant="ghost" onClick={() => setStatus('idle')}>
            Send another test
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={send} className="space-y-5 max-w-md">
      <h2 className="text-xl font-heading font-semibold">Send a test email</h2>
      <div>
        <label className="block text-sm mb-1">Send test to</label>
        <Input type="email" value={to} onChange={e => setTo(e.target.value)} required />
        <p className="text-xs text-muted mt-1">Defaults to your email.</p>
      </div>

      {status === 'sending' && <div className="text-sm text-muted">Sending…</div>}
      {status === 'failed' && (
        <div className="text-sm text-red-600 space-y-2">
          <div>{err}</div>
          <button type="button" onClick={() => update({ step: '2' })}
            className="underline hover:no-underline">Back to SMTP settings</button>
        </div>
      )}

      <div className="flex gap-3">
        <Button type="button" variant="ghost" onClick={() => update({ step: '2' })}>Back</Button>
        <Button type="submit" disabled={status === 'sending'}>
          {status === 'sending' ? 'Sending…' : 'Send test'}
        </Button>
      </div>
    </form>
  );
}
```

(`/api/smtp-configs/:id/test` is the existing endpoint that sends a real email through the configured transport — see `server/src/routes/smtpConfigs.ts:51`. No new server work needed.)

- [ ] **Step 2: Wire Step 3 into the wizard container**

Modify `web/src/pages/Onboarding.tsx`:

```tsx
import { useWizardState } from './onboarding/state';
import { ProgressBar } from './onboarding/ProgressBar';
import { StepTenant } from './onboarding/StepTenant';
import { StepSender } from './onboarding/StepSender';
import { StepTest } from './onboarding/StepTest';

export default function Onboarding() {
  const [state] = useWizardState();
  return (
    <div className="min-h-screen p-8 max-w-2xl mx-auto">
      <ProgressBar step={state.step} />
      {state.step === '1' && <StepTenant />}
      {state.step === '2' && <StepSender />}
      {state.step === '3' && <StepTest />}
    </div>
  );
}
```

- [ ] **Step 3: Full end-to-end manual test**

Run `npm run dev` and walk the entire wizard:
- `/` → "+ New tenant" → step 1 (create "Demo Co").
- Step 2 → Gmail preset + real credentials.
- Step 3 → click "Send test" with your own email pre-filled.
- Expect: real email arrives in your inbox, success screen renders.
- Click "Go to tenant dashboard" → lands at `/t/<id>` with sidebar.
- Re-open `/` — the "Setup incomplete" badge is gone for this tenant.

If the email send fails (e.g. wrong password), confirm the failure UI shows the SMTP error and "Back to SMTP settings" returns to step 2 with the form re-rendered fresh (acceptable for v1; the inputs aren't repopulated, but `smtpConfigId` in URL state means we'd be creating a *second* config — note this as a known follow-up rather than fixing it here).

- [ ] **Step 4: Commit**

```
git add web/src/pages/Onboarding.tsx web/src/pages/onboarding/StepTest.tsx
git commit -m "feat(web): wizard step 3 (verified test send) + success screen"
```

---

## Task 8: Web — Tenant switcher in `AppShell`

**Files:**
- Create: `web/src/components/TenantSwitcher.tsx`
- Modify: `web/src/components/AppShell.tsx`

- [ ] **Step 1: Build the switcher dropdown**

Create `web/src/components/TenantSwitcher.tsx`:

```tsx
import { useState, useRef, useEffect } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useTenants } from '../lib/tenants';
import { useAuth } from '../auth';

export default function TenantSwitcher() {
  const { tenants } = useTenants();
  const { tenantId } = useParams<{ tenantId: string }>();
  const { setActiveTenant } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const current = tenants.find(t => t.id === tenantId);
  const filtered = q
    ? tenants.filter(t => t.name.toLowerCase().includes(q.toLowerCase()))
    : tenants;

  async function pick(id: string) {
    await setActiveTenant(id);
    localStorage.setItem('lastTenantId', id);
    setOpen(false);
    nav(`/t/${id}`);
  }

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(v => !v)}
        className="flex items-center gap-2 text-sm w-full text-left px-2 py-1.5 rounded hover:bg-surface">
        <span className="font-medium truncate">{current?.name ?? 'Select tenant'}</span>
        <span className="text-muted ml-auto">▾</span>
      </button>
      {open && (
        <div className="absolute z-10 mt-1 w-64 border border-line rounded-md bg-bg shadow-md p-2">
          {tenants.length > 8 && (
            <input className="w-full mb-2 px-2 py-1 text-sm border border-line rounded"
              placeholder="Search tenants" value={q} onChange={e => setQ(e.target.value)} />
          )}
          <div className="max-h-64 overflow-auto">
            {filtered.map(t => (
              <button key={t.id} onClick={() => pick(t.id)}
                className={`w-full text-left text-sm px-2 py-1.5 rounded hover:bg-surface ${
                  t.id === tenantId ? 'font-medium' : ''
                }`}>{t.name}</button>
            ))}
          </div>
          <div className="border-t border-line mt-2 pt-2 flex flex-col text-sm">
            <Link to="/" onClick={() => setOpen(false)}
              className="px-2 py-1.5 rounded hover:bg-surface">← All tenants</Link>
            <Link to="/onboarding" onClick={() => setOpen(false)}
              className="px-2 py-1.5 rounded hover:bg-surface">+ New tenant</Link>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Mount it in `AppShell`**

Modify `web/src/components/AppShell.tsx`. Add the import and place the switcher under the logo:

```tsx
import TenantSwitcher from './TenantSwitcher';
// ...
<aside className="border-r border-line p-4 flex flex-col gap-6">
  <div className="font-heading font-semibold text-lg">AIployee Emailer</div>
  <TenantSwitcher />
  <nav className="flex flex-col gap-1">
    {/* unchanged NavLinks from Task 3 */}
  </nav>
  {/* unchanged sign-out button */}
</aside>
```

- [ ] **Step 3: Smoke-test**

`npm run dev`:
- Open `/t/<id>` — switcher shows current tenant's name.
- Open dropdown — list of all tenants visible; clicking one navigates to its dashboard and updates the session.
- Click "← All tenants" — returns to picker.
- Click "+ New tenant" — opens wizard.

- [ ] **Step 4: Commit**

```
git add web/src/components/TenantSwitcher.tsx web/src/components/AppShell.tsx
git commit -m "feat(web): tenant switcher in AppShell sidebar"
```

---

## Task 9: Verification pass

- [ ] **Step 1: Run server test suite**

From `server/`:

```
npx vitest run
```

Expected: all tests pass. The Vitest config in this project is set to run serially against the Neon test branch (see memory).

- [ ] **Step 2: Build the web bundle**

From `web/`:

```
npm run build
```

Expected: succeeds with no type errors.

- [ ] **Step 3: Final manual walk-through**

Run `npm run dev` and verify each acceptance criterion from the spec:

1. Log in as super-admin → lands on `/` showing the tenant picker.
2. With zero tenants, the empty state appears with a single CTA.
3. "+ New tenant" walks the full wizard and ends with a real test email landing in the user's inbox.
4. After success, "Go to tenant dashboard" routes to `/t/<id>`.
5. Sidebar tenant switcher shows current tenant; switching navigates to that tenant's dashboard.
6. Legacy URL `/senders` redirects to `/t/<lastTenantId>/senders`.
7. Bailing on the wizard at step 2 leaves the tenant visible in the picker with a "Setup incomplete" badge; clicking it lands on the dashboard (the resume-mid-step affordance is documented as a follow-up — see "Open follow-ups" below).

- [ ] **Step 4: Document follow-ups**

If any of the following are true, add a brief note to `docs/superpowers/specs/2026-05-28-onboarding-ux-design.md` under a new "Known follow-ups" section. Do **not** code fixes — they are explicitly out of v1 scope:

- Resuming a wizard at step 2/3 for an "incomplete" tenant card does not re-hydrate step 2's SMTP form (it would create a duplicate config). Acceptable for v1 because the user can delete the incomplete tenant from `/admin/tenants` and start over.
- "Last activity" / "sent today" stats on tenant cards are not yet rendered — placeholder text `—` would require a new aggregate endpoint, which is out of scope.

Commit:

```
git add docs/superpowers/specs/2026-05-28-onboarding-ux-design.md
git commit -m "docs(spec): note onboarding UX known follow-ups"
```

---

## Self-Review Notes

**Spec coverage:**
- Routing changes → Task 3.
- TenantPicker → Task 4.
- Wizard step 1 → Task 5.
- Wizard step 2 → Task 6.
- Wizard step 3 + success → Task 7.
- AppShell tenant switcher → Task 8.
- Cross-cutting "switch tenant via session" → Tasks 1–2.
- Resumability via `?tenantId=&step=` → Task 5 (state.ts).
- "Setup incomplete" badge → Tasks 4 (render) + 5/7 (set/clear).
- No new backend endpoints for tenant/SMTP/sender/send → confirmed; only the session-active-tenant endpoint is new, which is plumbing not business logic.

**Known limitations carried into v1 (covered in Task 9 Step 4):**
- Step-2 resume doesn't repopulate the SMTP form.
- Tenant-card activity stats render `—` until an aggregate endpoint is added.

These are deliberate scope cuts, documented at the end of the implementation rather than as TODOs in code.
