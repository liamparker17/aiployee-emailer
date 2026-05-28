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
