import { useState, useRef, useEffect } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ChevronDown, ArrowLeft, Plus } from 'lucide-react';
import { useTenants } from '../lib/tenants';
import { useAuth } from '../auth';

export function TenantSwitcher() {
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
        className="flex items-center gap-2 text-sm w-full text-left px-3 py-2 rounded-lg border border-line-strong bg-surface-raised text-ink hover:border-accent transition">
        <span className="font-medium truncate">{current?.name ?? 'Select tenant'}</span>
        <ChevronDown size={14} className="text-ink-dim ml-auto" />
      </button>
      {open && (
        <div className="absolute z-10 mt-1 w-64 border border-line-strong rounded-xl bg-surface-raised shadow-glow p-2">
          {tenants.length > 8 && (
            <input className="w-full mb-2 px-2 py-1.5 text-sm rounded-lg border border-line-strong bg-surface text-ink placeholder:text-ink-dim focus:outline-none focus:border-accent"
              placeholder="Search tenants" value={q} onChange={e => setQ(e.target.value)} />
          )}
          <div className="max-h-64 overflow-auto">
            {filtered.map(t => (
              <button key={t.id} onClick={() => pick(t.id)}
                className={`w-full text-left text-sm px-2 py-1.5 rounded-lg text-ink-muted hover:bg-surface hover:text-white ${
                  t.id === tenantId ? 'bg-magenta/15 text-white font-medium' : ''
                }`}>{t.name}</button>
            ))}
          </div>
          <div className="border-t border-line mt-2 pt-2 flex flex-col text-sm">
            <Link to="/" onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-ink-muted hover:bg-surface hover:text-white"><ArrowLeft size={14} /> All tenants</Link>
            <Link to="/onboarding" onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-ink-muted hover:bg-surface hover:text-white"><Plus size={14} /> New tenant</Link>
          </div>
        </div>
      )}
    </div>
  );
}
