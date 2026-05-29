# GUI Revamp — AIployee Dark Brand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reskin the `web/` admin UI to aiployee.co.za's dark purple/magenta brand with full UX polish, changing zero functionality.

**Architecture:** The app routes all styling through a semantic token layer (`design-tokens.json` → `tailwind.config.ts` → shared components → pages). Remap the token layer and upgrade the shared components first, which reskins most of the app; then add presentational UX primitives (toasts, empty/loading/status states); then touch up each page. Existing Tailwind semantic names (`primary`, `muted`, `line`, `surface`, etc.) are kept as aliases so nothing breaks mid-migration.

**Tech Stack:** React 18, Vite 5, TypeScript, Tailwind CSS 3, react-router-dom 6, lucide-react (new).

**HARD CONSTRAINT — NO FUNCTIONAL CHANGES.** Every task is presentation-only. Do not change any `api(...)` call, route path, route definition, form submit logic, auth/tenant logic, or data shape. When editing a page, preserve all hooks, handlers, and network calls exactly; change only JSX/markup/classes and add presentational wrappers (Card, PageHeader, StatusBadge, EmptyState, Skeleton, toasts). If a refactor would alter behavior, don't do it.

**Verification model (no web unit tests exist):** Each task's "test" step is `cd web && npm run build` passing with no TypeScript/build errors. Final task does manual render spot-checks. Every task ends with a commit.

---

### Task 0: Add lucide-react dependency

**Files:**
- Modify: `web/package.json`

- [ ] **Step 1: Install the dependency**

Run from repo root:
```bash
cd web && npm install lucide-react@^0.460.0
```
Expected: `package.json` gains `"lucide-react"` under dependencies; `package-lock.json` updates; exit 0.

- [ ] **Step 2: Verify build still works**

Run: `cd web && npm run build`
Expected: build succeeds (PASS).

- [ ] **Step 3: Commit**

```bash
git add web/package.json package-lock.json web/package-lock.json
git commit -m "build(web): add lucide-react for UI icons"
```
(Only add the lockfile path that actually changed.)

---

### Task 1: Token & theme layer

**Files:**
- Modify: `web/design-tokens.json`
- Modify: `web/tailwind.config.ts`
- Modify: `web/src/theme.css`

- [ ] **Step 1: Rewrite `web/design-tokens.json`**

```json
{
  "fontBody": "Inter, system-ui, sans-serif",
  "fontHeading": "Inter, system-ui, sans-serif",
  "colorBg": "#0b0418",
  "colorSurface": "#1a0b2e",
  "colorSurfaceRaised": "#231040",
  "colorText": "#ffffff",
  "colorTextMuted": "#d8cfe4",
  "colorTextDim": "#8c7fa8",
  "colorAccent": "#7c3aed",
  "colorAccentHover": "#9d4efb",
  "colorAccentActive": "#6826c8",
  "colorMagenta": "#c026f2",
  "colorMagentaBright": "#d146ff",
  "colorLine": "#2a1a3e",
  "colorLineStrong": "#3d2a56",
  "colorSuccess": "#22c55e",
  "colorError": "#f43f5e",
  "colorCyan": "#22d3ee",
  "colorViolet": "#a855f7",
  "colorFocusRing": "#c026f2",
  "btnRadius": "9999px",
  "btnPadding": "12px 24px"
}
```

- [ ] **Step 2: Rewrite `web/tailwind.config.ts`**

```ts
import type { Config } from 'tailwindcss';
import tokens from './design-tokens.json' assert { type: 'json' };

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // brand semantic tokens
        bg: tokens.colorBg,
        surface: tokens.colorSurface,
        'surface-raised': tokens.colorSurfaceRaised,
        ink: tokens.colorText,
        'ink-muted': tokens.colorTextMuted,
        'ink-dim': tokens.colorTextDim,
        accent: tokens.colorAccent,
        'accent-hover': tokens.colorAccentHover,
        'accent-active': tokens.colorAccentActive,
        magenta: tokens.colorMagenta,
        'magenta-bright': tokens.colorMagentaBright,
        line: tokens.colorLine,
        'line-strong': tokens.colorLineStrong,
        success: tokens.colorSuccess,
        error: tokens.colorError,
        cyan: tokens.colorCyan,
        violet: tokens.colorViolet,
        // legacy aliases so pre-existing classes keep working during migration
        primary: tokens.colorAccent,
        'primary-ink': tokens.colorText,
        muted: tokens.colorTextDim,
      },
      backgroundImage: {
        brand: `linear-gradient(135deg, ${tokens.colorMagenta} 0%, ${tokens.colorAccent} 100%)`,
      },
      boxShadow: {
        glow: `0 0 0 1px ${tokens.colorAccent}55, 0 8px 30px -8px ${tokens.colorMagenta}66`,
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

- [ ] **Step 3: Rewrite `web/src/theme.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

html, body, #root { height: 100%; }

body {
  background-color: #0b0418;
  color: #ffffff;
  /* subtle violet grid texture behind the app */
  background-image:
    linear-gradient(#7c3aed0a 1px, transparent 1px),
    linear-gradient(90deg, #7c3aed0a 1px, transparent 1px);
  background-size: 32px 32px;
  background-attachment: fixed;
}

h1, h2, h3, h4 { font-family: theme('fontFamily.heading'); font-weight: 600; }

::selection { background: #c026f2; color: #ffffff; }

/* dark scrollbars */
* { scrollbar-color: #3d2a56 transparent; }
*::-webkit-scrollbar { width: 10px; height: 10px; }
*::-webkit-scrollbar-thumb { background: #3d2a56; border-radius: 9999px; }
*::-webkit-scrollbar-track { background: transparent; }
```

- [ ] **Step 4: Verify build**

Run: `cd web && npm run build`
Expected: PASS (no errors; legacy aliases mean existing pages still compile).

- [ ] **Step 5: Commit**

```bash
git add web/design-tokens.json web/tailwind.config.ts web/src/theme.css
git commit -m "feat(web): dark AIployee brand token + theme layer"
```

---

### Task 2: Button component

**Files:**
- Modify: `web/src/components/Button.tsx`

- [ ] **Step 1: Rewrite `web/src/components/Button.tsx`** (props contract preserved; `secondary` added)

```tsx
import type { ButtonHTMLAttributes, ReactNode } from 'react';
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const cls: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:shadow-glow hover:brightness-110',
  secondary: 'bg-transparent text-ink border border-line-strong hover:border-accent hover:text-white',
  ghost: 'bg-transparent text-ink-muted hover:bg-surface hover:text-white',
  danger: 'bg-error text-white hover:brightness-110',
};
export function Button({ variant = 'primary', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; children: ReactNode }) {
  return (
    <button {...rest}
      className={`inline-flex items-center justify-center gap-2 rounded-btn text-sm font-medium px-4 py-2 transition disabled:opacity-50 disabled:cursor-not-allowed ${cls[variant]}`}>
      {children}
    </button>
  );
}
```

- [ ] **Step 2: Verify build** — `cd web && npm run build` → PASS
- [ ] **Step 3: Commit**

```bash
git add web/src/components/Button.tsx
git commit -m "feat(web): gradient brand button + secondary variant"
```

---

### Task 3: Input / Field components

**Files:**
- Modify: `web/src/components/Input.tsx`

- [ ] **Step 1: Rewrite `web/src/components/Input.tsx`**

```tsx
import type { InputHTMLAttributes, ReactNode } from 'react';
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props}
    className="w-full rounded-lg border border-line-strong bg-surface-raised text-ink placeholder:text-ink-dim px-3 py-2 text-sm transition focus:outline-none focus:border-accent focus:ring-2 focus:ring-magenta/40" />;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-ink-muted mb-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-ink-dim mt-1">{hint}</span>}
    </label>
  );
}
```

- [ ] **Step 2: Verify build** — `cd web && npm run build` → PASS
- [ ] **Step 3: Commit**

```bash
git add web/src/components/Input.tsx
git commit -m "feat(web): dark input + field styling"
```

---

### Task 4: Table component

**Files:**
- Modify: `web/src/components/Table.tsx`

- [ ] **Step 1: Rewrite `web/src/components/Table.tsx`**

```tsx
import type { ReactNode } from 'react';
export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="border border-line rounded-xl overflow-hidden bg-surface">
      <table className="w-full text-sm">{children}</table>
    </div>
  );
}
export function Th({ children }: { children: ReactNode }) {
  return <th className="text-left font-medium text-ink-dim uppercase text-xs tracking-wide bg-surface-raised px-4 py-3 border-b border-line">{children}</th>;
}
export function Td({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`px-4 py-3 border-b border-line text-ink-muted align-middle ${className}`}>{children}</td>;
}
```

Note: wrapping the `<table>` in a `<div>` is presentational only and does not affect any data or handlers.

- [ ] **Step 2: Verify build** — `cd web && npm run build` → PASS
- [ ] **Step 3: Commit**

```bash
git add web/src/components/Table.tsx
git commit -m "feat(web): dark table styling"
```

---

### Task 5: Modal component

**Files:**
- Modify: `web/src/components/Modal.tsx`

- [ ] **Step 1: Rewrite `web/src/components/Modal.tsx`** (keep portal + click-outside behavior identical)

```tsx
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm overflow-y-auto" onClick={onClose}>
      <div className="flex min-h-full items-start justify-center p-4">
        <div className="bg-surface-raised border border-line-strong rounded-2xl w-[480px] max-w-full my-8 p-6 shadow-glow" onClick={e => e.stopPropagation()}>
          <h3 className="text-lg font-semibold text-ink mb-4">{title}</h3>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 2: Verify build** — `cd web && npm run build` → PASS
- [ ] **Step 3: Commit**

```bash
git add web/src/components/Modal.tsx
git commit -m "feat(web): dark glowing modal"
```

---

### Task 6: Presentational primitives (Card, PageHeader, StatusBadge, EmptyState, Skeleton, Spinner)

**Files:**
- Create: `web/src/components/Card.tsx`
- Create: `web/src/components/PageHeader.tsx`
- Create: `web/src/components/StatusBadge.tsx`
- Create: `web/src/components/EmptyState.tsx`
- Create: `web/src/components/Skeleton.tsx`

- [ ] **Step 1: Create `web/src/components/Card.tsx`**

```tsx
import type { ReactNode } from 'react';
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`bg-surface border border-line rounded-2xl p-5 ${className}`}>{children}</div>;
}
```

- [ ] **Step 2: Create `web/src/components/PageHeader.tsx`**

```tsx
import type { ReactNode } from 'react';
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div>
        <h1 className="text-2xl font-heading font-semibold text-ink">{title}</h1>
        {subtitle && <p className="text-sm text-ink-dim mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
```

- [ ] **Step 3: Create `web/src/components/StatusBadge.tsx`**

```tsx
const styles: Record<string, string> = {
  sent: 'bg-success/15 text-success border-success/30',
  delivered: 'bg-success/15 text-success border-success/30',
  queued: 'bg-cyan/15 text-cyan border-cyan/30',
  sending: 'bg-cyan/15 text-cyan border-cyan/30',
  failed: 'bg-error/15 text-error border-error/30',
  bounced: 'bg-error/15 text-error border-error/30',
};
export function StatusBadge({ status }: { status: string }) {
  const s = styles[status.toLowerCase()] ?? 'bg-violet/15 text-violet border-violet/30';
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize ${s}`}>
      {status}
    </span>
  );
}
```

- [ ] **Step 4: Create `web/src/components/EmptyState.tsx`**

```tsx
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
export function EmptyState({ icon: Icon, title, description, action }: { icon: LucideIcon; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-4 border border-dashed border-line-strong rounded-2xl bg-surface/50">
      <div className="grid place-items-center h-12 w-12 rounded-xl bg-magenta/15 text-magenta mb-4">
        <Icon size={24} />
      </div>
      <h3 className="text-base font-medium text-ink">{title}</h3>
      {description && <p className="text-sm text-ink-dim mt-1 max-w-sm">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
```

- [ ] **Step 5: Create `web/src/components/Skeleton.tsx`**

```tsx
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-surface-raised ${className}`} />;
}
export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-line-strong border-t-magenta"
      style={{ width: size, height: size }}
    />
  );
}
```

- [ ] **Step 6: Verify build** — `cd web && npm run build` → PASS
- [ ] **Step 7: Commit**

```bash
git add web/src/components/Card.tsx web/src/components/PageHeader.tsx web/src/components/StatusBadge.tsx web/src/components/EmptyState.tsx web/src/components/Skeleton.tsx
git commit -m "feat(web): UX primitives — card, page header, status badge, empty state, skeleton"
```

---

### Task 7: Toast provider + useToast

**Files:**
- Create: `web/src/components/Toast.tsx`
- Modify: `web/src/main.tsx` (wrap app with `<ToastProvider>`)

- [ ] **Step 1: Create `web/src/components/Toast.tsx`**

```tsx
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CheckCircle2, XCircle, X } from 'lucide-react';

type Toast = { id: number; kind: 'success' | 'error'; message: string };
type ToastApi = { success: (m: string) => void; error: (m: string) => void };
const Ctx = createContext<ToastApi>({ success: () => {}, error: () => {} });
export function useToast() { return useContext(Ctx); }

let nextId = 1;
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const remove = useCallback((id: number) => setToasts(t => t.filter(x => x.id !== id)), []);
  const push = useCallback((kind: 'success' | 'error', message: string) => {
    const id = nextId++;
    setToasts(t => [...t, { id, kind, message }]);
    setTimeout(() => remove(id), 4000);
  }, [remove]);
  const api: ToastApi = {
    success: (m) => push('success', m),
    error: (m) => push('error', m),
  };
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
        {toasts.map(t => (
          <div key={t.id}
            className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm shadow-glow bg-surface-raised ${
              t.kind === 'success' ? 'border-success/40 text-success' : 'border-error/40 text-error'
            }`}>
            {t.kind === 'success' ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
            <span className="text-ink">{t.message}</span>
            <button onClick={() => remove(t.id)} className="ml-2 text-ink-dim hover:text-ink"><X size={14} /></button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
```

Note: `useCallback` is imported from `react` — correct the import to `import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';` (already shown above).

- [ ] **Step 2: Wrap the app in `web/src/main.tsx`**

Read `web/src/main.tsx` first. Wrap the existing root element tree with `<ToastProvider>...</ToastProvider>` at the outermost app level (inside any router/auth providers is fine, but it must wrap the routed content). Add the import:
```tsx
import { ToastProvider } from './components/Toast';
```
Do not change any other logic in `main.tsx`.

- [ ] **Step 3: Verify build** — `cd web && npm run build` → PASS
- [ ] **Step 4: Commit**

```bash
git add web/src/components/Toast.tsx web/src/main.tsx
git commit -m "feat(web): toast notification system"
```

---

### Task 8: AppShell — dark sidebar + nav icons + gradient wordmark

**Files:**
- Modify: `web/src/components/AppShell.tsx`

- [ ] **Step 1: Rewrite `web/src/components/AppShell.tsx`** (same routes, same `logout`/`nav` logic, same `tenantId` persistence — only markup + icons change)

```tsx
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { useEffect } from 'react';
import { LayoutDashboard, Send, FileText, Server, KeyRound, ScrollText, ShieldBan, Users, Building2, LogOut } from 'lucide-react';
import { useAuth } from '../auth';
import TenantSwitcher from './TenantSwitcher';

const link = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition ${
    isActive
      ? 'bg-magenta/15 text-white font-medium shadow-[inset_3px_0_0_0_#c026f2]'
      : 'text-ink-muted hover:text-white hover:bg-surface'
  }`;

export default function AppShell() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const { tenantId } = useParams<{ tenantId: string }>();
  useEffect(() => {
    if (tenantId) localStorage.setItem('lastTenantId', tenantId);
  }, [tenantId]);
  const base = `/t/${tenantId}`;
  return (
    <div className="min-h-full grid grid-cols-[248px_1fr]">
      <aside className="border-r border-line bg-surface/60 p-4 flex flex-col gap-6">
        <div className="flex items-center gap-2 px-2">
          <div className="h-8 w-8 rounded-lg bg-brand shadow-glow" />
          <span className="font-heading font-semibold text-lg bg-brand bg-clip-text text-transparent">AIployee</span>
        </div>
        <TenantSwitcher />
        <nav className="flex flex-col gap-1">
          <NavLink to={base} end className={link}><LayoutDashboard size={16} />Dashboard</NavLink>
          <NavLink to={`${base}/senders`} className={link}><Send size={16} />Senders</NavLink>
          <NavLink to={`${base}/templates`} className={link}><FileText size={16} />Templates</NavLink>
          <NavLink to={`${base}/smtp`} className={link}><Server size={16} />SMTP configs</NavLink>
          <NavLink to={`${base}/api-keys`} className={link}><KeyRound size={16} />API keys</NavLink>
          <NavLink to={`${base}/log`} className={link}><ScrollText size={16} />Email log</NavLink>
          <NavLink to={`${base}/suppressions`} className={link}><ShieldBan size={16} />Suppressions</NavLink>
          <NavLink to={`${base}/users`} className={link}><Users size={16} />Users</NavLink>
          {user?.role === 'super_admin' && <NavLink to="/admin/tenants" className={link}><Building2 size={16} />Tenants</NavLink>}
        </nav>
        <button onClick={async () => { await logout(); nav('/login'); }}
          className="mt-auto flex items-center gap-2 text-sm text-ink-dim hover:text-white text-left px-3 py-2 rounded-lg hover:bg-surface transition">
          <LogOut size={16} />Sign out
        </button>
      </aside>
      <main className="p-8 max-w-5xl"><Outlet /></main>
    </div>
  );
}
```

Verify the NavLink `to` paths exactly match the originals before committing (they do above — `base`, `senders`, `templates`, `smtp`, `api-keys`, `log`, `suppressions`, `users`, `/admin/tenants`).

- [ ] **Step 2: Verify build** — `cd web && npm run build` → PASS
- [ ] **Step 3: Commit**

```bash
git add web/src/components/AppShell.tsx
git commit -m "feat(web): dark sidebar with nav icons + gradient wordmark"
```

---

### Task 9: TenantSwitcher — dark popover

**Files:**
- Modify: `web/src/components/TenantSwitcher.tsx`

- [ ] **Step 1: Restyle only.** Read the current file. Preserve all logic (state, `pick`, click-outside effect, filtering, navigation). Apply these class changes:
  - Trigger button: `flex items-center gap-2 text-sm w-full text-left px-3 py-2 rounded-lg border border-line-strong bg-surface-raised text-ink hover:border-accent transition`
  - `▾` caret span: `text-ink-dim ml-auto`
  - Popover container: `absolute z-10 mt-1 w-64 border border-line-strong rounded-xl bg-surface-raised shadow-glow p-2`
  - Search input: `w-full mb-2 px-2 py-1.5 text-sm rounded-lg border border-line-strong bg-surface text-ink placeholder:text-ink-dim focus:outline-none focus:border-accent`
  - Tenant item buttons: `w-full text-left text-sm px-2 py-1.5 rounded-lg text-ink-muted hover:bg-surface hover:text-white ${t.id === tenantId ? 'bg-magenta/15 text-white font-medium' : ''}`
  - Footer divider: `border-t border-line mt-2 pt-2 flex flex-col text-sm`
  - Footer links: `px-2 py-1.5 rounded-lg text-ink-muted hover:bg-surface hover:text-white`

Replace `▾` with the lucide `ChevronDown` icon (`import { ChevronDown } from 'lucide-react';`, render `<ChevronDown size={14} className="text-ink-dim ml-auto" />`). Leave `←` / `+` glyphs as text or swap for lucide `ArrowLeft`/`Plus` (optional). Do not change `to` paths (`/`, `/onboarding`).

- [ ] **Step 2: Verify build** — `cd web && npm run build` → PASS
- [ ] **Step 3: Commit**

```bash
git add web/src/components/TenantSwitcher.tsx
git commit -m "feat(web): dark tenant switcher popover"
```

---

### Task 10: Login + AcceptInvite — dark brand auth screens

**Files:**
- Modify: `web/src/pages/Login.tsx`
- Modify: `web/src/pages/AcceptInvite.tsx`

- [ ] **Step 1: Restyle `Login.tsx`.** Preserve the `login`/`nav`/state/submit logic exactly. Replace the outer wrapper and card classes:
  - Outer: `min-h-screen grid place-items-center p-4`
  - Form card: `bg-surface-raised border border-line-strong p-8 rounded-2xl w-[380px] shadow-glow space-y-4`
  - Add a brand mark above the heading:
    ```tsx
    <div className="flex items-center gap-2 mb-2">
      <div className="h-9 w-9 rounded-lg bg-brand shadow-glow" />
      <span className="font-heading font-semibold text-xl bg-brand bg-clip-text text-transparent">AIployee</span>
    </div>
    ```
  - Heading: keep text, class `text-xl font-heading font-semibold text-ink`
  - Error line: change `text-red-600` → `text-error`
  - Keep `<Field>`/`<Input>`/`<Button>` usage unchanged.

- [ ] **Step 2: Restyle `AcceptInvite.tsx`.** Read it first. Apply the same dark card treatment (`bg-surface-raised border border-line-strong rounded-2xl shadow-glow`), swap any `text-red-*` → `text-error`, `text-green-*` → `text-success`, and dark-friendly text colors (`text-ink` / `text-ink-muted`). Preserve all token/invite logic and API calls.

- [ ] **Step 3: Verify build** — `cd web && npm run build` → PASS
- [ ] **Step 4: Commit**

```bash
git add web/src/pages/Login.tsx web/src/pages/AcceptInvite.tsx
git commit -m "feat(web): dark brand auth screens"
```

---

### Task 11: Dashboard — brand stat cards, status badges, loading

**Files:**
- Modify: `web/src/pages/Dashboard.tsx`

- [ ] **Step 1: Restyle `Dashboard.tsx`.** Preserve the `useEffect` fetch, `emails` state, and `counts` reduce exactly. Changes:
  - Add a loading flag derived presentationally: introduce `const [loading, setLoading] = useState(true);` and set it false in the existing `.then(...)` callback (`api<...>('/api/emails?limit=10').then(r => { setEmails(r.emails); setLoading(false); });`). This does not change the network call.
  - Replace the manual `<h1>` with `<PageHeader title="Dashboard" />` (import it).
  - Stat cards: map the 4 statuses with brand stat colors. Replace the stat card block with:
    ```tsx
    const stats = [
      { key: 'sent', label: 'Sent', color: 'text-success', ring: 'border-success/30' },
      { key: 'queued', label: 'Queued', color: 'text-cyan', ring: 'border-cyan/30' },
      { key: 'failed', label: 'Failed', color: 'text-error', ring: 'border-error/30' },
      { key: 'bounced', label: 'Bounced', color: 'text-violet', ring: 'border-violet/30' },
    ];
    // ...
    <div className="grid grid-cols-4 gap-4">
      {stats.map(s => (
        <div key={s.key} className={`bg-surface border ${s.ring} rounded-2xl p-4`}>
          <div className="text-xs uppercase tracking-wide text-ink-dim">{s.label}</div>
          <div className={`text-3xl font-semibold mt-1 ${s.color}`}>{counts[s.key] ?? 0}</div>
        </div>
      ))}
    </div>
    ```
  - Latest emails: heading `text-lg font-heading font-semibold text-ink mb-3`. In the table body, render the status cell via `<StatusBadge status={e.status} />` instead of plain `{e.status}` (import `StatusBadge`).
  - When `loading`, render 5 `<Skeleton className="h-9" />` rows in place of the table body; when `!loading && emails.length === 0`, render `<EmptyState icon={Inbox} title="No emails yet" description="Sent emails will appear here." />` (import `Inbox` from lucide-react and `EmptyState`).

- [ ] **Step 2: Verify build** — `cd web && npm run build` → PASS
- [ ] **Step 3: Commit**

```bash
git add web/src/pages/Dashboard.tsx
git commit -m "feat(web): brand dashboard stat cards, status badges, loading + empty states"
```

---

### Task 12: Onboarding — ProgressBar + steps restyle

**Files:**
- Modify: `web/src/pages/onboarding/ProgressBar.tsx`
- Modify: `web/src/pages/Onboarding.tsx`
- Modify: `web/src/pages/onboarding/StepTenant.tsx`
- Modify: `web/src/pages/onboarding/StepSender.tsx`
- Modify: `web/src/pages/onboarding/StepTest.tsx`

- [ ] **Step 1: Read all five files.** They contain the multi-step onboarding flow + shared `state.ts` (do not modify `state.ts`).

- [ ] **Step 2: Restyle presentation only.** Preserve all step logic, validation, API calls, and `next`/`back` navigation. Apply:
  - `ProgressBar`: completed/active segments use `bg-brand`; inactive `bg-line-strong`; labels `text-ink-muted` (active) / `text-ink-dim` (inactive).
  - Step containers: wrap content in `<Card>` (import from `../../components/Card`) or apply `bg-surface-raised border border-line-strong rounded-2xl p-6`.
  - Headings → `text-ink`, body copy → `text-ink-muted`, hints → `text-ink-dim`.
  - Any `text-red-*` → `text-error`, `text-green-*` → `text-success`.
  - Use existing `<Button>`/`<Input>`/`<Field>` (already restyled).

- [ ] **Step 3: Verify build** — `cd web && npm run build` → PASS
- [ ] **Step 4: Commit**

```bash
git add web/src/pages/Onboarding.tsx web/src/pages/onboarding/ProgressBar.tsx web/src/pages/onboarding/StepTenant.tsx web/src/pages/onboarding/StepSender.tsx web/src/pages/onboarding/StepTest.tsx
git commit -m "feat(web): dark onboarding flow"
```

---

### Task 13: List/CRUD pages — PageHeader, empty states, loading, toasts, badges

Apply the **same recipe** to each page below, one page per commit. For EACH page: read the file first, then transform **presentation only** — never touch `api(...)` calls, route logic, or data handling.

**Recipe per page:**
1. Replace the manual `<h1>...</h1>` (and any "New X" button row) with `<PageHeader title="..." subtitle="..." actions={<Button ...>New X</Button>} />`. Reuse the page's existing create handler on the button — do not change it.
2. If the page fetches a list with `useEffect`, add a presentational `loading` flag (default `true`, set `false` in the existing `.then` callback) and render `<Skeleton className="h-9" />` rows (or a `<Spinner />`) while loading. Do not alter the fetch call itself.
3. When the loaded list is empty, render `<EmptyState icon={<relevant lucide icon>} title="..." description="..." action={<Button>...</Button>} />`.
4. On successful create/update/delete, call `toast.success('...')`; in the `catch`, call `toast.error((err as Error).message)`. Get `toast` via `const toast = useToast();`. Wrap existing handler bodies — keep the underlying `api(...)` call and its arguments identical. If a handler currently swallows errors silently, keep its behavior and just add the toast.
5. Swap any hardcoded light colors: `text-red-*`→`text-error`, `text-green-*`→`text-success`, `bg-white`→`bg-surface`/`bg-surface-raised`, `text-gray-*`/`text-slate-*`→`text-ink-muted`/`text-ink-dim`, `border-gray-*`→`border-line`.
6. For pages showing email/send statuses (Email log), render `<StatusBadge status={...} />` in the status column.

**Pages + suggested icons/copy:**

- [ ] **Senders** (`web/src/pages/Senders.tsx`) — icon `Send`, empty "No senders yet" / "Add a verified sender to start sending." → commit `feat(web): dark senders page`
- [ ] **Templates** (`web/src/pages/Templates.tsx`) — icon `FileText`, empty "No templates yet" → commit `feat(web): dark templates page`
- [ ] **SmtpConfigs** (`web/src/pages/SmtpConfigs.tsx`) — icon `Server`, empty "No SMTP configs" → commit `feat(web): dark SMTP configs page`
- [ ] **ApiKeys** (`web/src/pages/ApiKeys.tsx`) — icon `KeyRound`, empty "No API keys" / "Create a key to integrate Jobix." Add `toast.success('Copied')` to any existing copy-to-clipboard action. Keep the Jobix setup guide content intact. → commit `feat(web): dark API keys page`
- [ ] **EmailLog** (`web/src/pages/EmailLog.tsx`) — icon `ScrollText`, empty "No emails logged", use `<StatusBadge>` in status column. → commit `feat(web): dark email log with status badges`
- [ ] **Suppressions** (`web/src/pages/Suppressions.tsx`) — icon `ShieldBan`, empty "No suppressions" → commit `feat(web): dark suppressions page`
- [ ] **Users** (`web/src/pages/Users.tsx`) — icon `Users`, empty "No users yet" → commit `feat(web): dark users page`
- [ ] **AdminTenants** (`web/src/pages/AdminTenants.tsx`) — icon `Building2`, empty "No tenants yet" → commit `feat(web): dark admin tenants page`
- [ ] **TenantPicker** (`web/src/pages/TenantPicker.tsx`) — restyle the tenant selection cards to `bg-surface border border-line hover:border-accent rounded-2xl` with brand hover; icon `Building2` for empty state. → commit `feat(web): dark tenant picker`

After each page: `cd web && npm run build` → PASS, then commit with the message above.

---

### Task 14: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full build** — `cd web && npm run build` → PASS, no warnings about unused brand tokens that indicate a missed page.

- [ ] **Step 2: Grep for leftover light-theme classes** that indicate missed spots:

Run: `cd web && git grep -nE 'text-red-[0-9]|text-green-[0-9]|bg-white|text-gray-[0-9]|text-slate-[0-9]|border-gray-[0-9]' -- 'src/**/*.tsx'`
Expected: no results (or only intentional ones you can justify). Fix any stragglers, then build + commit.

- [ ] **Step 3: Manual render spot-check.** Run `cd web && npm run dev`, then in a browser:
  - Login screen renders dark with brand wordmark; sign in works.
  - Sidebar shows icons + gradient logo; active item has magenta accent; navigation works.
  - Dashboard stat cards are colored; status badges render; empty/loading states appear correctly.
  - Open a create modal on one list page (e.g. Senders), submit → toast appears, row added (confirming functionality unchanged).
  - Confirm no console errors.

- [ ] **Step 4: Behavior-diff sanity check.** Run `git diff master --stat` and skim the page diffs to confirm no `api(`, route path, or handler logic lines were changed — only JSX/className/import lines and the additive `loading`/`toast` presentational code.

- [ ] **Step 5: Final commit (if Step 2 fixed anything)**

```bash
git add -A
git commit -m "chore(web): final brand reskin cleanup + verification"
```

---

## Self-Review Notes

- **Spec coverage:** token layer (T1), all 5 shared components (T2–T5, T8, T9), all 6 new primitives incl. toast (T6, T7), Dashboard (T11), Login/AcceptInvite (T10), Onboarding (T12), all 9 list/CRUD pages (T13), lucide-react dep (T0), build verification (every task + T14). ✓
- **No-functional-change constraint:** enforced in the header and repeated per task; T14 Step 4 adds an explicit behavior-diff check. ✓
- **Type consistency:** `StatusBadge`/`EmptyState`/`Card`/`PageHeader`/`Skeleton`/`Spinner`/`useToast`/`ToastProvider` names are used consistently across T6, T7, T11, T13. ✓
- **Note:** Page transformations in T12/T13 are recipe-based (not full code) because each page must be read first; this is appropriate for a mechanical reskin and the recipe is fully specified. Executor must read each file before editing.
