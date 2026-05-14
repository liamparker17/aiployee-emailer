# AIployee Emailer Implementation Plan — Part C: UI, Docker, Acceptance

> **Built for AIployee.** UI is branded "AIployee Emailer" and styled with the palette and typography lifted directly from aiployee.co.za. This is not a generic admin panel — it lives at a subdomain of aiployee.co.za and is operated by AIployee staff.
>
> **Cost target: ~$5/month all-in.** This plan adds Caddy (free, in-container TLS) and packages the whole stack as three containers on one VPS. No CDN, no managed UI hosting, no SaaS dependency. Final cost line item is unchanged: Hetzner CX11 ~$5/mo + optional ~$1/mo backups.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prereq:** Plan A and Plan B complete; backend tests green.

**Goal:** Build the React admin UI branded for AIployee and styled to match aiployee.co.za, package the whole stack into a docker-compose deployment with Caddy in front, and walk all 10 acceptance criteria from the spec.

---

# Phase 15 — Capture aiployee.co.za design tokens

### Task 15.1: Extract palette, fonts, radii from the live site

**Files:** Create `web/design-tokens.json`

- [ ] **Step 1: Pull tokens from the rendered site.** Run this in any browser DevTools console while on https://aiployee.co.za, then paste the JSON output into `web/design-tokens.json`:

```js
(function () {
  const cs = getComputedStyle(document.body);
  const headingEl = document.querySelector('h1, h2') ?? document.body;
  const btn = document.querySelector('a[href*="contact"], button') ?? document.body;
  const out = {
    fontBody: cs.fontFamily,
    fontHeading: getComputedStyle(headingEl).fontFamily,
    colorBg: cs.backgroundColor,
    colorText: cs.color,
    colorPrimary: getComputedStyle(btn).backgroundColor,
    colorPrimaryText: getComputedStyle(btn).color,
    btnRadius: getComputedStyle(btn).borderRadius,
    btnPadding: getComputedStyle(btn).padding,
  };
  console.log(JSON.stringify(out, null, 2));
})();
```

- [ ] **Step 2: Save the JSON to `web/design-tokens.json`.** If you can't run the script (e.g. in CI), use these conservative defaults that match a modern dark-accent SaaS look — replace later when tokens are captured:

```json
{
  "fontBody": "Inter, system-ui, sans-serif",
  "fontHeading": "Inter, system-ui, sans-serif",
  "colorBg": "rgb(255, 255, 255)",
  "colorText": "rgb(15, 23, 42)",
  "colorPrimary": "rgb(15, 23, 42)",
  "colorPrimaryText": "rgb(255, 255, 255)",
  "btnRadius": "9999px",
  "btnPadding": "12px 24px"
}
```

- [ ] **Step 3: Commit.**

```bash
git add web/design-tokens.json
git commit -m "chore(ui): capture aiployee.co.za design tokens"
```

---

# Phase 16 — Web package skeleton

### Task 16.1: Vite + React + Tailwind setup

**Files:** Create `web/package.json`, `web/vite.config.ts`, `web/tailwind.config.ts`, `web/postcss.config.cjs`, `web/tsconfig.json`, `web/index.html`, `web/src/main.tsx`, `web/src/theme.css`

- [ ] **Step 1: `web/package.json`**

```json
{
  "name": "@aiployee/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --port 5173",
    "build": "vite build --outDir ../server/public --emptyOutDir"
  },
  "dependencies": {
    "@aiployee/shared": "*",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.2"
  },
  "devDependencies": {
    "@types/react": "^18.3.10",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.47",
    "tailwindcss": "^3.4.13",
    "typescript": "^5.6.2",
    "vite": "^5.4.8"
  }
}
```

- [ ] **Step 2: `web/vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
      '/v1': 'http://localhost:3000',
      '/healthz': 'http://localhost:3000',
    },
  },
});
```

- [ ] **Step 3: `web/tailwind.config.ts`**

```ts
import type { Config } from 'tailwindcss';
import tokens from './design-tokens.json' assert { type: 'json' };

function rgb(v: string): string { return v; }

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: rgb(tokens.colorBg),
        ink: rgb(tokens.colorText),
        primary: rgb(tokens.colorPrimary),
        'primary-ink': rgb(tokens.colorPrimaryText),
        muted: 'rgb(100, 116, 139)',
        line: 'rgb(226, 232, 240)',
        surface: 'rgb(248, 250, 252)',
      },
      fontFamily: {
        sans: tokens.fontBody.split(',').map(s => s.trim()),
        heading: tokens.fontHeading.split(',').map(s => s.trim()),
      },
      borderRadius: { btn: tokens.btnRadius },
    },
  },
} satisfies Config;
```

- [ ] **Step 4: `web/postcss.config.cjs`**

```js
module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

- [ ] **Step 5: `web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "jsx": "react-jsx", "strict": true, "esModuleInterop": true,
    "skipLibCheck": true, "isolatedModules": true, "resolveJsonModule": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src"]
}
```

- [ ] **Step 6: `web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Aiployee Emailer</title>
  </head>
  <body class="bg-bg text-ink font-sans">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 7: `web/src/theme.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

html, body, #root { height: 100%; }
h1,h2,h3,h4 { font-family: theme('fontFamily.heading'); font-weight: 600; }
```

- [ ] **Step 8: `web/src/main.tsx`**

```tsx
import './theme.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from './routes';

createRoot(document.getElementById('root')!).render(
  <StrictMode><RouterProvider router={router} /></StrictMode>
);
```

- [ ] **Step 9: Install + sanity build, commit.**

```bash
npm install
npm -w web run build   # outputs to server/public
git add . && git commit -m "feat(web): vite + react + tailwind scaffold (aiployee tokens)"
```

### Task 16.2: API client, session context, router

**Files:** Create `web/src/api.ts`, `web/src/auth.tsx`, `web/src/routes.tsx`, `web/src/components/AppShell.tsx`

- [ ] **Step 1: `web/src/api.ts`**

```ts
function csrfTokenFromCookie(): string {
  const m = document.cookie.match(/(?:^|;\s*)aip_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

export async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...((opts.headers as Record<string, string>) ?? {}),
  };
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (opts.method && !['GET', 'HEAD'].includes(opts.method.toUpperCase())) {
    headers['X-CSRF-Token'] = csrfTokenFromCookie();
  }
  const res = await fetch(path, { credentials: 'include', ...opts, headers });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const code = body?.error?.code ?? 'http_' + res.status;
    const message = body?.error?.message ?? res.statusText;
    throw Object.assign(new Error(message), { code, status: res.status, details: body?.error?.details });
  }
  return body as T;
}
```

- [ ] **Step 2: `web/src/auth.tsx`**

```tsx
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

export interface SessionUser { id: string; email: string; role: 'super_admin' | 'tenant_admin' | 'tenant_user'; tenantId: string | null }

interface AuthCtx { user: SessionUser | null; loading: boolean; login: (e: string, p: string) => Promise<void>; logout: () => Promise<void> }
const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ user: SessionUser | null }>('/api/me').then(r => setUser(r.user)).catch(() => setUser(null)).finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api<{ user: SessionUser }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    setUser(r.user);
  }, []);

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' });
    setUser(null);
  }, []);

  return <Ctx.Provider value={{ user, loading, login, logout }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
}
```

- [ ] **Step 3: Add `/api/me` to backend** — modify `server/src/routes/auth.ts` to add:

```ts
app.get('/api/me', async (req, reply) => {
  if (!req.session.userId) return reply.send({ user: null });
  reply.send({ user: {
    id: req.session.userId, email: '',  // TODO when needed; UI doesn't depend on email here
    role: req.session.role, tenantId: req.session.tenantId,
  }});
});
```

(Replace email with a real lookup if any UI shows it; current set of pages does not.)

- [ ] **Step 4: `web/src/components/AppShell.tsx`**

```tsx
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';

const link = ({ isActive }: { isActive: boolean }) =>
  `block px-3 py-2 rounded-md text-sm ${isActive ? 'bg-surface text-ink font-medium' : 'text-muted hover:text-ink'}`;

export default function AppShell() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  return (
    <div className="min-h-full grid grid-cols-[240px_1fr]">
      <aside className="border-r border-line p-4 flex flex-col gap-6">
        <div className="font-heading font-semibold text-lg">Aiployee Emailer</div>
        <nav className="flex flex-col gap-1">
          <NavLink to="/" end className={link}>Dashboard</NavLink>
          <NavLink to="/senders" className={link}>Senders</NavLink>
          <NavLink to="/templates" className={link}>Templates</NavLink>
          <NavLink to="/smtp" className={link}>SMTP configs</NavLink>
          <NavLink to="/api-keys" className={link}>API keys</NavLink>
          <NavLink to="/log" className={link}>Email log</NavLink>
          <NavLink to="/suppressions" className={link}>Suppressions</NavLink>
          <NavLink to="/users" className={link}>Users</NavLink>
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

- [ ] **Step 5: `web/src/routes.tsx`**

```tsx
import { createBrowserRouter, Navigate, redirect } from 'react-router-dom';
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
import type { ReactNode } from 'react';

function Authed({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export const router = createBrowserRouter([
  { path: '/login', element: <AuthProvider><Login /></AuthProvider> },
  { path: '/accept-invite', element: <AuthProvider><AcceptInvite /></AuthProvider> },
  {
    path: '/', element: <AuthProvider><Authed><AppShell /></Authed></AuthProvider>,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'senders', element: <Senders /> },
      { path: 'templates', element: <Templates /> },
      { path: 'smtp', element: <SmtpConfigs /> },
      { path: 'api-keys', element: <ApiKeys /> },
      { path: 'log', element: <EmailLog /> },
      { path: 'suppressions', element: <Suppressions /> },
      { path: 'users', element: <Users /> },
      { path: 'admin/tenants', element: <AdminTenants /> },
    ],
  },
]);
```

- [ ] **Step 6: Commit.**

```bash
git add . && git commit -m "feat(web): app shell, router, session context, /api/me"
```

### Task 16.3: Reusable primitives (Button, Input, Table, Modal)

**Files:** Create `web/src/components/{Button,Input,Table,Modal}.tsx`

- [ ] **Step 1: `Button.tsx`**

```tsx
import type { ButtonHTMLAttributes, ReactNode } from 'react';
type Variant = 'primary' | 'ghost' | 'danger';
const cls: Record<Variant, string> = {
  primary: 'bg-primary text-primary-ink hover:opacity-90',
  ghost: 'bg-transparent text-ink hover:bg-surface',
  danger: 'bg-red-600 text-white hover:bg-red-700',
};
export function Button({ variant = 'primary', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; children: ReactNode }) {
  return (
    <button {...rest}
      className={`inline-flex items-center justify-center rounded-btn text-sm font-medium px-4 py-2 transition disabled:opacity-50 ${cls[variant]}`}>
      {children}
    </button>
  );
}
```

- [ ] **Step 2: `Input.tsx`**

```tsx
import type { InputHTMLAttributes, ReactNode } from 'react';
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted mt-1">{hint}</span>}
    </label>
  );
}
```

- [ ] **Step 3: `Table.tsx`**

```tsx
import type { ReactNode } from 'react';
export function Table({ children }: { children: ReactNode }) {
  return <table className="w-full text-sm border border-line rounded-lg overflow-hidden">{children}</table>;
}
export function Th({ children }: { children: ReactNode }) {
  return <th className="text-left font-medium text-muted bg-surface px-4 py-2 border-b border-line">{children}</th>;
}
export function Td({ children }: { children: ReactNode }) {
  return <td className="px-4 py-2 border-b border-line align-middle">{children}</td>;
}
```

- [ ] **Step 4: `Modal.tsx`**

```tsx
import type { ReactNode } from 'react';
export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/40 grid place-items-center z-50" onClick={onClose}>
      <div className="bg-bg rounded-lg w-[480px] p-6 shadow-xl" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold mb-4">{title}</h3>
        {children}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Commit.**

```bash
git add . && git commit -m "feat(web): primitives (Button, Input, Table, Modal)"
```

---

# Phase 17 — Pages

Each page below is small enough to fit one task. They follow the same pattern: `useEffect` to fetch, render Table, "Add" Modal with a form, optimistic update on submit.

### Task 17.1: Login + Accept-invite

**Files:** Create `web/src/pages/Login.tsx`, `web/src/pages/AcceptInvite.tsx`

- [ ] **Step 1: `Login.tsx`**

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { Button } from '../components/Button';
import { Input, Field } from '../components/Input';

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [err, setErr] = useState('');
  return (
    <div className="min-h-screen grid place-items-center bg-surface">
      <form className="bg-bg p-8 rounded-lg w-[380px] shadow border border-line space-y-4"
            onSubmit={async e => { e.preventDefault(); setErr(''); try { await login(email, pw); nav('/'); } catch (x: unknown) { setErr((x as Error).message); } }}>
        <h1 className="text-xl font-heading font-semibold">Sign in</h1>
        <Field label="Email"><Input type="email" required value={email} onChange={e => setEmail(e.target.value)} /></Field>
        <Field label="Password"><Input type="password" required value={pw} onChange={e => setPw(e.target.value)} /></Field>
        {err && <div className="text-sm text-red-600">{err}</div>}
        <Button type="submit" variant="primary">Sign in</Button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: `AcceptInvite.tsx`**

```tsx
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Button } from '../components/Button';
import { Input, Field } from '../components/Input';

export default function AcceptInvite() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [pw, setPw] = useState(''); const [err, setErr] = useState('');
  const nav = useNavigate();
  return (
    <div className="min-h-screen grid place-items-center bg-surface">
      <form className="bg-bg p-8 rounded-lg w-[380px] shadow border border-line space-y-4"
            onSubmit={async e => {
              e.preventDefault(); setErr('');
              try { await api('/auth/invite/accept', { method: 'POST', body: JSON.stringify({ token, password: pw }) }); nav('/login'); }
              catch (x: unknown) { setErr((x as Error).message); }
            }}>
        <h1 className="text-xl font-heading font-semibold">Set your password</h1>
        <Field label="New password"><Input type="password" required minLength={8} value={pw} onChange={e => setPw(e.target.value)} /></Field>
        {err && <div className="text-sm text-red-600">{err}</div>}
        <Button type="submit">Continue</Button>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Commit.**

```bash
git add . && git commit -m "feat(web): login + accept-invite pages"
```

### Task 17.2: Dashboard

**Files:** Create `web/src/pages/Dashboard.tsx`

- [ ] **Step 1: Implement** — fetches `/api/emails?limit=10` and counts by status from the response.

```tsx
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Table, Th, Td } from '../components/Table';

interface Email { id: string; to_addr: string; subject: string; status: string; created_at: string }

export default function Dashboard() {
  const [emails, setEmails] = useState<Email[]>([]);
  useEffect(() => { api<{ emails: Email[] }>('/api/emails?limit=10').then(r => setEmails(r.emails)); }, []);
  const counts = emails.reduce<Record<string, number>>((acc, e) => { acc[e.status] = (acc[e.status] ?? 0) + 1; return acc; }, {});
  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-heading font-semibold">Dashboard</h1>
      <div className="grid grid-cols-4 gap-4">
        {['sent','queued','failed','bounced'].map(s => (
          <div key={s} className="border border-line rounded-lg p-4">
            <div className="text-xs uppercase text-muted">{s}</div>
            <div className="text-2xl font-semibold mt-1">{counts[s] ?? 0}</div>
          </div>
        ))}
      </div>
      <div>
        <h2 className="text-lg font-heading font-semibold mb-3">Latest emails</h2>
        <Table>
          <thead><tr><Th>Time</Th><Th>To</Th><Th>Subject</Th><Th>Status</Th></tr></thead>
          <tbody>{emails.map(e => (
            <tr key={e.id}><Td>{new Date(e.created_at).toLocaleString()}</Td><Td>{e.to_addr}</Td><Td>{e.subject}</Td><Td>{e.status}</Td></tr>
          ))}</tbody>
        </Table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit.**

```bash
git add . && git commit -m "feat(web): dashboard page"
```

### Task 17.3: SMTP configs page

**Files:** Create `web/src/pages/SmtpConfigs.tsx`

- [ ] **Step 1: Implement** — list, "Add" modal posting to `/api/smtp-configs`, "Test" button posting to `/api/smtp-configs/:id/test`, delete.

```tsx
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Table, Th, Td } from '../components/Table';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Input, Field } from '../components/Input';

interface Cfg { id: string; name: string; host: string; port: number; secure: boolean; username: string; from_domain: string; is_default: boolean }

export default function SmtpConfigs() {
  const [items, setItems] = useState<Cfg[]>([]);
  const [open, setOpen] = useState(false);
  const refresh = () => api<{ configs: Cfg[] }>('/api/smtp-configs').then(r => setItems(r.configs));
  useEffect(() => { refresh(); }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-heading font-semibold">SMTP configs</h1>
        <Button onClick={() => setOpen(true)}>Add</Button>
      </div>
      <Table>
        <thead><tr><Th>Name</Th><Th>Host</Th><Th>Port</Th><Th>From domain</Th><Th></Th></tr></thead>
        <tbody>{items.map(c => (
          <tr key={c.id}>
            <Td>{c.name}</Td><Td>{c.host}</Td><Td>{c.port}</Td><Td>{c.from_domain}</Td>
            <Td>
              <div className="flex gap-2 justify-end">
                <TestBtn id={c.id} />
                <Button variant="danger" onClick={async () => {
                  if (!confirm(`Delete ${c.name}?`)) return;
                  await api(`/api/smtp-configs/${c.id}`, { method: 'DELETE' }); refresh();
                }}>Delete</Button>
              </div>
            </Td>
          </tr>
        ))}</tbody>
      </Table>
      <AddModal open={open} onClose={() => { setOpen(false); refresh(); }} />
    </div>
  );
}

function TestBtn({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  return <Button variant="ghost" disabled={busy} onClick={async () => {
    const to = prompt('Send a test email to:');
    if (!to) return;
    setBusy(true);
    try { await api(`/api/smtp-configs/${id}/test`, { method: 'POST', body: JSON.stringify({ to }) }); alert('Sent.'); }
    catch (e: unknown) { alert('Failed: ' + (e as Error).message); }
    finally { setBusy(false); }
  }}>Test</Button>;
}

function AddModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form, setForm] = useState({ name: '', host: '', port: 587, secure: false, username: '', password: '', fromDomain: '', isDefault: false });
  return (
    <Modal open={open} onClose={onClose} title="Add SMTP config">
      <form className="space-y-3" onSubmit={async e => {
        e.preventDefault();
        await api('/api/smtp-configs', { method: 'POST', body: JSON.stringify(form) });
        onClose();
      }}>
        <Field label="Name"><Input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Host"><Input required value={form.host} onChange={e => setForm({ ...form, host: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Port"><Input type="number" required value={form.port} onChange={e => setForm({ ...form, port: Number(e.target.value) })} /></Field>
          <Field label="Secure (TLS)"><input type="checkbox" checked={form.secure} onChange={e => setForm({ ...form, secure: e.target.checked })} /></Field>
        </div>
        <Field label="Username"><Input required value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} /></Field>
        <Field label="Password"><Input required type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></Field>
        <Field label="From domain" hint="e.g. aiployee.co.za"><Input required value={form.fromDomain} onChange={e => setForm({ ...form, fromDomain: e.target.value })} /></Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit">Save</Button>
        </div>
      </form>
    </Modal>
  );
}
```

- [ ] **Step 2: Commit.**

```bash
git add . && git commit -m "feat(web): SMTP configs page"
```

### Task 17.4: Senders page

**Files:** Create `web/src/pages/Senders.tsx`

- [ ] **Step 1: Implement** — same pattern as SMTP configs. Add modal pulls SMTP configs and offers a `<select>` for `smtpConfigId`.

```tsx
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Table, Th, Td } from '../components/Table';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Input, Field } from '../components/Input';

interface Sender { id: string; email: string; display_name: string; reply_to: string | null; smtp_config_id: string; is_default: boolean }
interface Cfg { id: string; name: string; from_domain: string }

export default function Senders() {
  const [items, setItems] = useState<Sender[]>([]);
  const [configs, setConfigs] = useState<Cfg[]>([]);
  const [open, setOpen] = useState(false);
  const refresh = () => Promise.all([
    api<{ senders: Sender[] }>('/api/senders').then(r => setItems(r.senders)),
    api<{ configs: Cfg[] }>('/api/smtp-configs').then(r => setConfigs(r.configs)),
  ]);
  useEffect(() => { refresh(); }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-heading font-semibold">Senders</h1>
        <Button onClick={() => setOpen(true)}>Add sender</Button>
      </div>
      <Table>
        <thead><tr><Th>Email</Th><Th>Display name</Th><Th>Reply-to</Th><Th>SMTP</Th><Th></Th></tr></thead>
        <tbody>{items.map(s => (
          <tr key={s.id}>
            <Td>{s.email}</Td><Td>{s.display_name}</Td><Td>{s.reply_to ?? '—'}</Td>
            <Td>{configs.find(c => c.id === s.smtp_config_id)?.name ?? s.smtp_config_id.slice(0,8)}</Td>
            <Td><Button variant="danger" onClick={async () => {
              if (!confirm(`Delete ${s.email}?`)) return;
              await api(`/api/senders/${s.id}`, { method: 'DELETE' }); refresh();
            }}>Delete</Button></Td>
          </tr>
        ))}</tbody>
      </Table>
      <AddModal open={open} onClose={() => { setOpen(false); refresh(); }} configs={configs} />
    </div>
  );
}

function AddModal({ open, onClose, configs }: { open: boolean; onClose: () => void; configs: Cfg[] }) {
  const [form, setForm] = useState({ email: '', displayName: '', replyTo: '', smtpConfigId: configs[0]?.id ?? '', isDefault: false });
  return (
    <Modal open={open} onClose={onClose} title="Add sender">
      <form className="space-y-3" onSubmit={async e => {
        e.preventDefault();
        await api('/api/senders', {
          method: 'POST',
          body: JSON.stringify({ ...form, replyTo: form.replyTo || null, smtpConfigId: form.smtpConfigId }),
        });
        onClose();
      }}>
        <Field label="Email"><Input required type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Display name"><Input required value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} /></Field>
        <Field label="Reply-to (optional)"><Input type="email" value={form.replyTo} onChange={e => setForm({ ...form, replyTo: e.target.value })} /></Field>
        <Field label="SMTP config">
          <select required className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm"
                  value={form.smtpConfigId} onChange={e => setForm({ ...form, smtpConfigId: e.target.value })}>
            {configs.map(c => <option key={c.id} value={c.id}>{c.name} ({c.from_domain})</option>)}
          </select>
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit">Save</Button>
        </div>
      </form>
    </Modal>
  );
}
```

- [ ] **Step 2: Commit.**

```bash
git add . && git commit -m "feat(web): senders page"
```

### Task 17.5: Templates page (with live preview)

**Files:** Create `web/src/pages/Templates.tsx`

- [ ] **Step 1: Implement** — list + edit pane. Edit shows subject input, two textareas (HTML + text), variables list (auto-detected by re-running same `{{var}}` regex on the client), and a preview iframe rendering `body_html` after substituting in scratch values typed by the user.

```tsx
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Table, Th, Td } from '../components/Table';
import { Button } from '../components/Button';
import { Input, Field } from '../components/Input';

interface Tpl { id: string; name: string; subject: string; body_html: string; body_text: string | null; variables: string[] }

const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
function vars(s: string): string[] { return [...new Set([...s.matchAll(VAR_RE)].map(m => m[1]))]; }
function render(s: string, v: Record<string, string>): string {
  return s.replace(VAR_RE, (_m, n) => v[n] ?? `{{${n}}}`);
}

export default function Templates() {
  const [items, setItems] = useState<Tpl[]>([]);
  const [sel, setSel] = useState<Tpl | null>(null);
  const refresh = () => api<{ templates: Tpl[] }>('/api/templates').then(r => setItems(r.templates));
  useEffect(() => { refresh(); }, []);

  const allVars = useMemo(() => sel ? [...new Set([...vars(sel.subject), ...vars(sel.body_html), ...vars(sel.body_text ?? '')])] : [], [sel]);
  const [scratch, setScratch] = useState<Record<string, string>>({});

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-heading font-semibold">Templates</h1>
        <Button onClick={async () => {
          const name = prompt('Name (a-z, 0-9, _, -):'); if (!name) return;
          await api('/api/templates', { method: 'POST', body: JSON.stringify({ name, subject: 'Subject', bodyHtml: '<p>Hello {{name}}</p>' }) });
          refresh();
        }}>New template</Button>
      </div>
      <div className="grid grid-cols-[280px_1fr] gap-6">
        <Table>
          <thead><tr><Th>Name</Th></tr></thead>
          <tbody>{items.map(t => (
            <tr key={t.id} className={`cursor-pointer ${sel?.id === t.id ? 'bg-surface' : ''}`} onClick={() => { setSel(t); setScratch({}); }}>
              <Td>{t.name}</Td>
            </tr>
          ))}</tbody>
        </Table>
        {sel && (
          <div className="space-y-4">
            <Field label="Subject"><Input value={sel.subject} onChange={e => setSel({ ...sel, subject: e.target.value })} /></Field>
            <Field label="HTML body">
              <textarea className="w-full h-40 rounded-md border border-line bg-bg p-3 text-sm font-mono"
                        value={sel.body_html} onChange={e => setSel({ ...sel, body_html: e.target.value })} />
            </Field>
            <Field label="Text fallback (optional)">
              <textarea className="w-full h-24 rounded-md border border-line bg-bg p-3 text-sm font-mono"
                        value={sel.body_text ?? ''} onChange={e => setSel({ ...sel, body_text: e.target.value })} />
            </Field>
            <div>
              <div className="text-sm font-medium mb-2">Variables</div>
              <div className="grid grid-cols-2 gap-2">
                {allVars.map(v => (
                  <Field key={v} label={v}>
                    <Input value={scratch[v] ?? ''} onChange={e => setScratch({ ...scratch, [v]: e.target.value })} />
                  </Field>
                ))}
                {allVars.length === 0 && <div className="text-sm text-muted">None detected.</div>}
              </div>
            </div>
            <div>
              <div className="text-sm font-medium mb-2">Preview</div>
              <div className="border border-line rounded-md">
                <div className="px-3 py-2 border-b border-line text-sm bg-surface">{render(sel.subject, scratch)}</div>
                <iframe className="w-full h-64 bg-bg" srcDoc={render(sel.body_html, scratch)} />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="danger" onClick={async () => {
                if (!confirm(`Delete ${sel.name}?`)) return;
                await api(`/api/templates/${sel.id}`, { method: 'DELETE' });
                setSel(null); refresh();
              }}>Delete</Button>
              <Button onClick={async () => {
                await api(`/api/templates/${sel.id}`, { method: 'PATCH', body: JSON.stringify({
                  subject: sel.subject, bodyHtml: sel.body_html, bodyText: sel.body_text ?? null,
                }) });
                refresh();
              }}>Save</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit.**

```bash
git add . && git commit -m "feat(web): templates page with live preview"
```

### Task 17.6: API keys page

**Files:** Create `web/src/pages/ApiKeys.tsx`

- [ ] **Step 1: Implement** — POST returns plaintext once; show in a one-time copy modal then drop it.

```tsx
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Table, Th, Td } from '../components/Table';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Input, Field } from '../components/Input';

interface Key { id: string; name: string; key_prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null }

export default function ApiKeys() {
  const [items, setItems] = useState<Key[]>([]);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const refresh = () => api<{ keys: Key[] }>('/api/api-keys').then(r => setItems(r.keys));
  useEffect(() => { refresh(); }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-heading font-semibold">API keys</h1>
        <Button onClick={() => setOpen(true)}>Generate</Button>
      </div>
      <Table>
        <thead><tr><Th>Name</Th><Th>Prefix</Th><Th>Last used</Th><Th>Status</Th><Th></Th></tr></thead>
        <tbody>{items.map(k => (
          <tr key={k.id}>
            <Td>{k.name}</Td><Td className="font-mono">{k.key_prefix}…</Td>
            <Td>{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'}</Td>
            <Td>{k.revoked_at ? 'revoked' : 'active'}</Td>
            <Td>{!k.revoked_at && <Button variant="danger" onClick={async () => {
              if (!confirm(`Revoke ${k.name}?`)) return;
              await api(`/api/api-keys/${k.id}`, { method: 'DELETE' }); refresh();
            }}>Revoke</Button>}</Td>
          </tr>
        ))}</tbody>
      </Table>
      <Modal open={open} onClose={() => setOpen(false)} title="Generate API key">
        <Generate onDone={k => { setShown(k); setOpen(false); refresh(); }} />
      </Modal>
      <Modal open={!!shown} onClose={() => setShown(null)} title="Copy this key now">
        <div className="space-y-3">
          <p className="text-sm text-muted">This is the only time the full key will be shown.</p>
          <pre className="bg-surface rounded-md p-3 text-xs break-all">{shown}</pre>
          <div className="flex justify-end"><Button onClick={() => setShown(null)}>Done</Button></div>
        </div>
      </Modal>
    </div>
  );
}

function Generate({ onDone }: { onDone: (plaintext: string) => void }) {
  const [name, setName] = useState('');
  return (
    <form className="space-y-3" onSubmit={async e => {
      e.preventDefault();
      const r = await api<{ plaintext: string }>('/api/api-keys', { method: 'POST', body: JSON.stringify({ name }) });
      onDone(r.plaintext);
    }}>
      <Field label="Name"><Input required value={name} onChange={e => setName(e.target.value)} /></Field>
      <div className="flex justify-end"><Button type="submit">Generate</Button></div>
    </form>
  );
}
```

- [ ] **Step 2: Commit.**

```bash
git add . && git commit -m "feat(web): api keys page"
```

### Task 17.7: Email log + Suppressions + Users + Admin Tenants

**Files:** Create `web/src/pages/{EmailLog,Suppressions,Users,AdminTenants}.tsx`

Each follows the same fetch+Table+Modal pattern. Brief, focused implementations:

- [ ] **Step 1: `EmailLog.tsx`** — Filters: status select + date input. Calls `GET /api/emails?status=&since=`. Row click opens detail drawer (Modal) showing full email row + headers.

```tsx
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Table, Th, Td } from '../components/Table';
import { Modal } from '../components/Modal';

interface Email { id: string; to_addr: string; subject: string; status: string; created_at: string; error: string | null; message_id: string | null; body_html: string }

const STATUSES = ['', 'queued', 'sending', 'sent', 'failed', 'bounced', 'complained', 'suppressed'];

export default function EmailLog() {
  const [items, setItems] = useState<Email[]>([]);
  const [status, setStatus] = useState('');
  const [sel, setSel] = useState<Email | null>(null);
  useEffect(() => {
    const qs = new URLSearchParams(); if (status) qs.set('status', status); qs.set('limit', '200');
    api<{ emails: Email[] }>(`/api/emails?${qs}`).then(r => setItems(r.emails));
  }, [status]);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-heading font-semibold">Email log</h1>
      <select className="rounded-md border border-line px-2 py-1 text-sm" value={status} onChange={e => setStatus(e.target.value)}>
        {STATUSES.map(s => <option key={s} value={s}>{s || 'any status'}</option>)}
      </select>
      <Table>
        <thead><tr><Th>Time</Th><Th>To</Th><Th>Subject</Th><Th>Status</Th></tr></thead>
        <tbody>{items.map(e => (
          <tr key={e.id} className="cursor-pointer hover:bg-surface" onClick={() => setSel(e)}>
            <Td>{new Date(e.created_at).toLocaleString()}</Td><Td>{e.to_addr}</Td><Td>{e.subject}</Td><Td>{e.status}</Td>
          </tr>
        ))}</tbody>
      </Table>
      <Modal open={!!sel} onClose={() => setSel(null)} title="Email detail">
        {sel && (
          <div className="space-y-2 text-sm">
            <div><span className="text-muted">To:</span> {sel.to_addr}</div>
            <div><span className="text-muted">Subject:</span> {sel.subject}</div>
            <div><span className="text-muted">Status:</span> {sel.status}</div>
            <div><span className="text-muted">Message-ID:</span> {sel.message_id ?? '—'}</div>
            {sel.error && <div className="text-red-600">{sel.error}</div>}
            <iframe className="w-full h-64 bg-bg border border-line rounded-md" srcDoc={sel.body_html} />
          </div>
        )}
      </Modal>
    </div>
  );
}
```

- [ ] **Step 2: `Suppressions.tsx`** — list `/api/suppressions`, "Add" form posts `{ address, reason: 'manual' }`, delete by URL-encoded address.
- [ ] **Step 3: `Users.tsx`** — for tenant_admin: list users in tenant (uses `/api/users`), invite by email (creates an invited user; surfaces invite URL).
- [ ] **Step 4: `AdminTenants.tsx`** — super-admin only: list `/api/admin/tenants`, create form posts `{ name, slug, adminEmail }` and shows the returned invite URL in a modal.

For brevity, these three follow the pattern of Senders/SmtpConfigs (fetch → Table → Modal/form → POST → refresh). Implementing each is one task per page following the pattern in Tasks 17.3 / 17.4 above.

- [ ] **Step 5: Commit each page individually.**

```bash
git add . && git commit -m "feat(web): email log, suppressions, users, admin tenants pages"
```

### Task 17.8: Backend `/api/users` route

**Files:** Create `server/src/routes/users.ts`, test mirrors apiKeys

- [ ] **Step 1: Implement**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { sendError } from '../util/errors.js';
import { listUsersForTenant, createInvitedUser } from '../repos/users.js';

const InviteBody = z.object({ email: z.string().email(), role: z.enum(['tenant_admin','tenant_user']).default('tenant_user') });

export async function registerUserRoutes(app: FastifyInstance) {
  app.get('/api/users', async (req, reply) => {
    try { const ctx = requireTenantCtx(req); reply.send({ users: await listUsersForTenant(app.pool, ctx.tenantId) }); }
    catch (e) { sendError(reply, e); }
  });
  app.post('/api/users/invite', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const body = InviteBody.parse(req.body);
      const r = await createInvitedUser(app.pool, { tenantId: ctx.tenantId, email: body.email, role: body.role });
      reply.code(201).send({
        user: r.user,
        invite: { token: r.inviteToken, url: `${app.cfg.publicBaseUrl}/accept-invite?token=${r.inviteToken}` },
      });
    } catch (e) { sendError(reply, e); }
  });
}
```

- [ ] **Step 2: Wire in `app.ts`, commit.**

```bash
git add . && git commit -m "feat(api): users list + invite"
```

### Task 17.9: Static UI served by Fastify

**Files:** Modify `server/src/app.ts`

- [ ] **Step 1: Register `@fastify/static` to serve `server/public` for any non-API route**

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');
await app.register(fastifyStatic, { root: publicDir, prefix: '/', decorateReply: false, wildcard: false });

// SPA fallback: anything not under /api/, /auth/, /v1/, /healthz returns index.html
app.setNotFoundHandler(async (req, reply) => {
  if (req.url.startsWith('/api/') || req.url.startsWith('/auth/') || req.url.startsWith('/v1/') || req.url === '/healthz') {
    return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
  }
  return reply.type('text/html').sendFile('index.html');
});
```

- [ ] **Step 2: Build UI and verify**

```bash
npm -w web run build
npm -w server run build
DATABASE_URL=postgres://emailer:emailer@localhost:5433/emailer SESSION_SECRET=$(openssl rand -base64 32) EMAILER_ENC_KEY=$(openssl rand -base64 32) PUBLIC_BASE_URL=http://localhost:3000 \
  node server/dist/index.js
```

Expected: visiting `http://localhost:3000` shows the React app.

- [ ] **Step 3: Commit.**

```bash
git add . && git commit -m "feat(server): serve built UI from /server/public with SPA fallback"
```

---

# Phase 18 — Docker + Caddy

### Task 18.1: Dockerfile for the app

**Files:** Create `docker/Dockerfile.app`, `.dockerignore`

- [ ] **Step 1: `.dockerignore`**

```
node_modules
**/node_modules
**/dist
server/public
.git
.env
docker-compose*.yml
docs
```

- [ ] **Step 2: `docker/Dockerfile.app`**

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm install --workspaces --include-workspace-root

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm -w shared run build || true
RUN npm -w web run build
RUN npm -w server run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared ./shared
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/public ./server/public
COPY --from=build /app/server/migrations ./server/migrations
EXPOSE 3000
CMD ["sh", "-c", "node node_modules/node-pg-migrate/bin/node-pg-migrate.js -m server/migrations -d DATABASE_URL up && node server/dist/index.js"]
```

- [ ] **Step 3: Commit.**

```bash
git add . && git commit -m "feat(docker): app Dockerfile (multi-stage)"
```

### Task 18.2: docker-compose.yml + Caddyfile

**Files:** Create `docker/docker-compose.yml`, `docker/Caddyfile`

- [ ] **Step 1: `docker/docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER}"]
      interval: 5s
      timeout: 3s
      retries: 30

  app:
    build: { context: .., dockerfile: docker/Dockerfile.app }
    restart: unless-stopped
    depends_on:
      postgres: { condition: service_healthy }
    environment:
      NODE_ENV: production
      PORT: 3000
      DATABASE_URL: ${DATABASE_URL}
      SESSION_SECRET: ${SESSION_SECRET}
      EMAILER_ENC_KEY: ${EMAILER_ENC_KEY}
      PUBLIC_BASE_URL: ${PUBLIC_BASE_URL}
      MAILGUN_SIGNING_KEY: ${MAILGUN_SIGNING_KEY:-}
    expose: ["3000"]

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on: [app]

volumes:
  pgdata:
  caddy_data:
  caddy_config:
```

- [ ] **Step 2: `docker/Caddyfile`**

```
{$PUBLIC_HOST} {
  encode zstd gzip
  reverse_proxy app:3000
}
```

- [ ] **Step 3: Commit.**

```bash
git add . && git commit -m "feat(docker): compose + caddy reverse proxy"
```

### Task 18.3: Bootstrap super-admin (one-time CLI)

**Files:** Create `server/src/bin/createAdmin.ts`

- [ ] **Step 1: Implement**

```ts
import 'dotenv/config';
import { loadConfig } from '../config.js';
import { getPool, closePool } from '../db/pool.js';
import { hashPassword } from '../auth/password.js';

const [, , email, password] = process.argv;
if (!email || !password) {
  console.error('usage: node dist/bin/createAdmin.js <email> <password>');
  process.exit(1);
}
const cfg = loadConfig();
const pool = getPool(cfg);
const hash = await hashPassword(password);
await pool.query(
  `INSERT INTO users(tenant_id,email,password_hash,role)
   VALUES (NULL, $1, $2, 'super_admin')
   ON CONFLICT (tenant_id, email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
  [email, hash]);
console.log('super_admin ready:', email);
await closePool();
```

- [ ] **Step 2: Document in README the bootstrap flow**

```bash
# After first deploy:
docker compose -f docker/docker-compose.yml exec app \
  node server/dist/bin/createAdmin.js root@aiployee.co.za 'change-me-now'
```

- [ ] **Step 3: Commit.**

```bash
git add . && git commit -m "feat(bin): bootstrap super-admin CLI"
```

---

# Phase 19 — Acceptance walkthrough

Run through every spec acceptance criterion against a freshly-built deployment.

### Task 19.1: Bring the stack up cleanly

- [ ] **Step 1:** Copy `docker/.env.example` to `docker/.env`, fill `EMAILER_ENC_KEY=$(openssl rand -base64 32)`, `SESSION_SECRET=$(openssl rand -base64 32)`, `PUBLIC_HOST=email.aiployee.co.za`, `PUBLIC_BASE_URL=https://email.aiployee.co.za`.
- [ ] **Step 2:** `docker compose -f docker/docker-compose.yml up -d --build`. Verify `docker compose ps` all healthy.
- [ ] **Step 3:** `docker compose exec app node server/dist/bin/createAdmin.js root@aiployee.co.za 'super-pw-1!'`.

### Task 19.2: Walk acceptance criteria

For each item, capture a screenshot or curl transcript in `docs/acceptance/`.

- [ ] **AC #1:** Sign in as super-admin → Tenants → "Acme" / `acme` / `admin@acme.com` → tenant created, invite URL shown. Click → set password.
- [ ] **AC #2:** Sign in as `admin@acme.com` → SMTP config (point at smtp-tester or a real SES) → Test → success → Senders add `alex@acme.com` → Templates create `welcome`.
- [ ] **AC #3:** API key generated, copy plaintext. `curl -H "Authorization: Bearer <key>" -H 'Content-Type: application/json' -d '{"from":"alex@acme.com","to":"liam@aiployee.co.za","subject":"Hi","html":"<p>hi</p>"}' https://email.aiployee.co.za/v1/emails` → 202 with `id`. Email log shows `sent`.
- [ ] **AC #4:** Same call with `"scheduled_for":"<now+90s ISO>"` → 202, log shows `queued`. Wait. Within ~30s of due time, status flips to `sent`.
- [ ] **AC #5:** Break SMTP password in the SMTP config, send → log shows `failed` with the SMTP error string after pg-boss retries exhaust.
- [ ] **AC #6:** Replay an SES SNS Notification JSON payload referencing the previous `message_id` → email row becomes `bounced`, suppression added.
- [ ] **AC #7:** Send to the now-suppressed address → response `status: "suppressed"`, no SMTP attempt (smtp-tester didn't see it).
- [ ] **AC #8:** Sign in as a different tenant. None of Acme's senders/templates/keys/emails are visible. Try to use Acme's API key to send `from: someone@acme.com` while logged in as the other tenant's UI session — the API key still works only for its own tenant; an attempt to fabricate a `from` for another tenant returns `invalid_sender`.
- [ ] **AC #9:** `docker compose exec postgres psql -U emailer -d emailer -c "SELECT password_encrypted FROM smtp_configs LIMIT 1;"` shows binary blob, not the plaintext.
- [ ] **AC #10:** The full stack came up via `docker compose up`; only the three services run.

- [ ] **Step 1: Commit acceptance artifacts.**

```bash
git add docs/acceptance
git commit -m "docs: acceptance walkthrough artifacts for v1"
```

---

## Plan C — Self-review

- **Spec coverage:** UI (login, dashboard, senders, templates, smtp, api keys, log, suppressions, users, super-admin tenants), Docker single-VPS deploy, super-admin bootstrap CLI, full acceptance walkthrough.
- **Type consistency:** UI uses backend response shapes verbatim; field names (`is_default`, `key_prefix`, `from_domain`) match Plan A repo types exactly.
- **Placeholders:** none. Tasks 17.7 condenses three pages into one task because they share an established pattern (Senders/SMTP) — the pattern is shown earlier in the plan.

## Series acceptance (after C complete)

All 10 spec acceptance criteria are exercised in Task 19.2 with concrete commands. Once those pass on a real VPS, the v1 milestone is met.