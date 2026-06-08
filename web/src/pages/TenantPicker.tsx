import { useState, useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Building2 } from 'lucide-react';
import { useAuth } from '@aiployee/ui';
import { useTenants } from '@aiployee/ui';
import { Input } from '@aiployee/ui';
import { Button } from '@aiployee/ui';
import { PageHeader } from '@aiployee/ui';
import { EmptyState } from '@aiployee/ui';

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
    <div className="min-h-screen bg-surface p-8 max-w-6xl mx-auto">
      <header className="flex items-center justify-between mb-8">
        <div className="font-heading font-semibold text-xl text-ink">Aiployee Emailer</div>
        <div className="flex items-center gap-4 text-sm text-ink-muted">
          <span>{user?.email}</span>
          <button
            onClick={async () => { await logout(); nav('/login'); }}
            className="hover:text-ink transition">
            Sign out
          </button>
        </div>
      </header>

      <PageHeader
        title="Tenants"
        actions={<Link to="/onboarding"><Button>+ New tenant</Button></Link>}
      />

      {tenants.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No tenants yet"
          description="Create your first one to get started."
          action={<Link to="/onboarding"><Button>+ New tenant</Button></Link>}
        />
      ) : (
        <>
          {tenants.length > 8 && (
            <div className="mb-4 max-w-sm">
              <Input placeholder="Search tenants" value={q} onChange={e => setQ(e.target.value)} />
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map(t => (
              <button
                key={t.id}
                onClick={() => open(t.id)}
                className="bg-surface border border-line hover:border-accent rounded-2xl p-5 text-left transition">
                <div className="font-medium text-lg text-ink">{t.name}</div>
                <div className="text-xs text-ink-dim mt-1">{t.slug}</div>
                {t.id === incompleteId && (
                  <div className="mt-3 inline-block text-xs bg-magenta/15 text-magenta px-2 py-0.5 rounded-btn">
                    Setup incomplete
                  </div>
                )}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="col-span-full text-ink-muted text-sm">No tenants match "{q}".</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
