import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { useEffect, useState, type ReactNode } from 'react';
import { LayoutDashboard, Send, FileText, Server, ShieldCheck, KeyRound, Bot, Webhook, ScrollText, ShieldBan, Users, UsersRound, ListChecks, Filter, Megaphone, Rocket, Building2, LogOut, ChevronDown, ChevronRight } from 'lucide-react';
import { useAuth } from '@aiployee/ui';
import { TenantSwitcher } from '@aiployee/ui';
import { Logo } from '@aiployee/ui';

const link = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition ${
    isActive
      ? 'bg-magenta/15 text-white font-medium shadow-[inset_3px_0_0_0_#c026f2]'
      : 'text-ink-muted hover:text-white hover:bg-surface'
  }`;

// Collapsible nav group — open by default, choice persisted per group.
function NavGroup({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  const key = `nav.${id}.open`;
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(key) !== '0'; } catch { return true; }
  });
  const toggle = () => setOpen(o => {
    const next = !o;
    try { localStorage.setItem(key, next ? '1' : '0'); } catch { /* ignore */ }
    return next;
  });
  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex items-center gap-1.5 w-full text-[11px] font-medium uppercase tracking-wider text-ink-dim px-3 pt-4 pb-1 hover:text-ink-muted transition"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{label}</span>
      </button>
      {open && <div className="flex flex-col gap-0.5 pb-1">{children}</div>}
    </div>
  );
}

export default function AppShell() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const { tenantId } = useParams<{ tenantId: string }>();
  // persist for legacy-redirect fallback
  useEffect(() => {
    if (tenantId) localStorage.setItem('lastTenantId', tenantId);
  }, [tenantId]);
  const base = `/t/${tenantId}`;
  const isAdmin = user?.role !== 'tenant_user';
  return (
    <div className="min-h-full grid grid-cols-[248px_1fr]">
      <aside className="border-r border-line bg-surface/60 p-4 flex flex-col">
        <div className="flex items-center gap-2 px-2 mb-0.5">
          <Logo size={32} />
          <span className="font-heading font-semibold text-lg text-ink">Aiployee</span>
        </div>
        <p className="text-[11px] text-ink-dim px-2 mb-4">Your AI email employee</p>
        <TenantSwitcher />
        <a href="/auth/handoff?to=https://aiployee-command-centre.vercel.app"
          className="flex items-center gap-3 px-3 py-2 mt-2 rounded-lg text-sm text-magenta hover:bg-surface transition">
          <LayoutDashboard size={16} />Command Centre →
        </a>
        <nav className="flex flex-col gap-0.5 mt-2 overflow-y-auto">
          <NavGroup id="email" label="Email setup">
            <NavLink to={`${base}/senders`} className={link}><Send size={16} />Senders</NavLink>
            <NavLink to={`${base}/domains`} className={link}><ShieldCheck size={16} />Domains</NavLink>
            <NavLink to={`${base}/smtp`} className={link}><Server size={16} />SMTP configs</NavLink>
            <NavLink to={`${base}/templates`} className={link}><FileText size={16} />Templates</NavLink>
            <NavLink to={`${base}/dashboard`} className={link}><LayoutDashboard size={16} />Email overview</NavLink>
            <NavLink to={`${base}/log`} className={link}><ScrollText size={16} />Email log</NavLink>
            <NavLink to={`${base}/suppressions`} className={link}><ShieldBan size={16} />Suppressions</NavLink>
          </NavGroup>

          <NavGroup id="marketing" label="Marketing">
            <NavLink to={`${base}/launch-campaign`} className={link}><Rocket size={16} />Launch campaign</NavLink>
            <NavLink to={`${base}/contacts`} className={link}><UsersRound size={16} />Contacts</NavLink>
            <NavLink to={`${base}/lists`} className={link}><ListChecks size={16} />Lists</NavLink>
            <NavLink to={`${base}/segments`} className={link}><Filter size={16} />Segments</NavLink>
            <NavLink to={`${base}/campaigns`} className={link}><Megaphone size={16} />Campaigns</NavLink>
          </NavGroup>

          <NavGroup id="developers" label="Developers">
            <NavLink to={`${base}/api-keys`} className={link}><KeyRound size={16} />API keys</NavLink>
            <NavLink to={`${base}/ai-responses`} className={link}><Bot size={16} />AI responses</NavLink>
            <NavLink to={`${base}/event-webhooks`} className={link}><Webhook size={16} />Event webhooks</NavLink>
          </NavGroup>

          <NavGroup id="admin" label="Admin">
            <NavLink to={`${base}/users`} className={link}><Users size={16} />Users</NavLink>
            {user?.role === 'super_admin' && <NavLink to="/admin/tenants" className={link}><Building2 size={16} />Tenants</NavLink>}
          </NavGroup>
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
