import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { useEffect } from 'react';
import { LayoutDashboard, Bot, Phone, PhoneOutgoing, Workflow, Wand2, LogOut } from 'lucide-react';
import { useAuth } from '@aiployee/ui';
import { TenantSwitcher } from '@aiployee/ui';
import { Logo } from '@aiployee/ui';

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
        <p className="text-[11px] text-ink-dim px-2 mb-4">Command Centre</p>
        <TenantSwitcher />
        <nav className="flex flex-col gap-0.5 mt-2 overflow-y-auto">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-magenta px-3 pt-1 pb-1">
            Your AI employee
          </div>
          <NavLink to={`${base}/abe`} className={link}><Bot size={16} />Abe</NavLink>
          {isAdmin && (
            <NavLink to={`${base}/calls`} className={link}><Phone size={16} />Calls</NavLink>
          )}
          {isAdmin && (
            <NavLink to={`${base}/outbound-calls`} className={link}><PhoneOutgoing size={16} />Call Campaigns</NavLink>
          )}
          {isAdmin && (
            <NavLink to={`${base}/flows`} className={link}><Workflow size={16} />Flows</NavLink>
          )}
          {isAdmin && (
            <NavLink to={`${base}/jobix-builder`} className={link}><Wand2 size={16} />Jobix</NavLink>
          )}
          <NavLink to={`${base}/dashboard`} className={link}><LayoutDashboard size={16} />Dashboard</NavLink>
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
