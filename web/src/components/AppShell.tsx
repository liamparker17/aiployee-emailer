import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { useEffect } from 'react';
import { LayoutDashboard, Send, FileText, Server, ShieldCheck, KeyRound, Wand2, Bot, Webhook, ScrollText, ShieldBan, Users, UsersRound, ListChecks, Building2, LogOut } from 'lucide-react';
import { useAuth } from '../auth';
import TenantSwitcher from './TenantSwitcher';
import { Logo } from './Logo';

const link = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition ${
    isActive
      ? 'bg-magenta/15 text-white font-medium shadow-[inset_3px_0_0_0_#c026f2]'
      : 'text-ink-muted hover:text-white hover:bg-surface'
  }`;

function SectionLabel({ children }: { children: string }) {
  return <div className="text-[11px] font-medium uppercase tracking-wider text-ink-dim px-3 pt-4 pb-1">{children}</div>;
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
  return (
    <div className="min-h-full grid grid-cols-[248px_1fr]">
      <aside className="border-r border-line bg-surface/60 p-4 flex flex-col">
        <div className="flex items-center gap-2 px-2 mb-4">
          <Logo size={32} />
          <span className="font-heading font-semibold text-lg text-ink">Aiployee</span>
        </div>
        <TenantSwitcher />
        <nav className="flex flex-col gap-0.5 mt-2 overflow-y-auto">
          <NavLink to={base} end className={link}><LayoutDashboard size={16} />Dashboard</NavLink>

          <SectionLabel>Sending</SectionLabel>
          <NavLink to={`${base}/senders`} className={link}><Send size={16} />Senders</NavLink>
          <NavLink to={`${base}/domains`} className={link}><ShieldCheck size={16} />Domains</NavLink>
          <NavLink to={`${base}/smtp`} className={link}><Server size={16} />SMTP configs</NavLink>
          <NavLink to={`${base}/templates`} className={link}><FileText size={16} />Templates</NavLink>

          <SectionLabel>Activity</SectionLabel>
          <NavLink to={`${base}/log`} className={link}><ScrollText size={16} />Email log</NavLink>
          <NavLink to={`${base}/suppressions`} className={link}><ShieldBan size={16} />Suppressions</NavLink>

          <SectionLabel>Integrations</SectionLabel>
          <NavLink to={`${base}/api-keys`} className={link}><KeyRound size={16} />API keys</NavLink>
          <NavLink to={`${base}/jobix-builder`} className={link}><Wand2 size={16} />Jobix builder</NavLink>
          <NavLink to={`${base}/ai-responses`} className={link}><Bot size={16} />AI</NavLink>
          <NavLink to={`${base}/event-webhooks`} className={link}><Webhook size={16} />Event webhooks</NavLink>

          <SectionLabel>Marketing</SectionLabel>
          <NavLink to={`${base}/contacts`} className={link}><UsersRound size={16} />Contacts</NavLink>
          <NavLink to={`${base}/lists`} className={link}><ListChecks size={16} />Lists</NavLink>

          <SectionLabel>Admin</SectionLabel>
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
