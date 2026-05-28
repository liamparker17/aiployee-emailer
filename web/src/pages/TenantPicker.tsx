import { useState, useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { useTenants } from '../lib/tenants';
import { Input } from '../components/Input';
import { Button } from '../components/Button';

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
