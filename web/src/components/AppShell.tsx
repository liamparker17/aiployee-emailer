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
        <div className="font-heading font-semibold text-lg">AIployee Emailer</div>
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
