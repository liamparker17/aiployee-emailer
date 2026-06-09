import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { Table, Th, Td } from '../components/Table';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';
import { StatusBadge } from '../components/StatusBadge';
import { CopyButton } from '../components/CopyButton';
import { useToast } from '../components/Toast';

interface Domain {
  id: string;
  domain: string;
  verified: boolean;
  spf_ok: boolean;
  dmarc_ok: boolean;
  last_checked_at: string | null;
}

function Check() {
  return <span className="text-success font-bold">✓</span>;
}

function Dash() {
  return <span className="text-ink-dim">—</span>;
}

export default function Domains() {
  const [items, setItems] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [addValue, setAddValue] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const addRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const refresh = () =>
    api<{ domains: Domain[] }>('/api/domains')
      .then(r => setItems(r.domains))
      .finally(() => setLoading(false));

  useEffect(() => { refresh(); }, []);

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault();
    if (!addValue.trim()) return;
    setAddBusy(true);
    try {
      await api('/api/domains', { method: 'POST', body: JSON.stringify({ domain: addValue.trim() }) });
      toast.success('Domain added');
      setAddValue('');
      setAddOpen(false);
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setAddBusy(false);
    }
  };

  const handleVerify = async (d: Domain) => {
    setCheckingId(d.id);
    try {
      const res = await api<{ domain: Domain }>(`/api/domains/${d.id}/verify`, { method: 'POST' });
      toast.success(res.domain.verified ? 'Domain verified!' : 'DNS check complete — records not yet detected');
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setCheckingId(null);
    }
  };

  const handleRemove = async (d: Domain) => {
    if (!confirm(`Remove domain "${d.domain}"?`)) return;
    try {
      await api(`/api/domains/${d.id}`, { method: 'DELETE' });
      toast.success('Domain removed');
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sending domains"
        subtitle="Authenticate the domains you send from for better deliverability."
        actions={
          <Button onClick={() => { setAddOpen(v => !v); setTimeout(() => addRef.current?.focus(), 50); }}>
            Add domain
          </Button>
        }
      />

      {addOpen && (
        <form onSubmit={handleAdd} className="flex items-center gap-2">
          <Input
            ref={addRef}
            placeholder="mail.example.com"
            value={addValue}
            onChange={e => setAddValue(e.target.value)}
            className="max-w-xs"
          />
          <Button type="submit" disabled={addBusy}>
            {addBusy ? 'Adding…' : 'Add'}
          </Button>
          <Button type="button" variant="ghost" onClick={() => { setAddOpen(false); setAddValue(''); }}>
            Cancel
          </Button>
        </form>
      )}

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No domains yet"
          description="Add a domain to see the SPF/DMARC records to configure."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Domain</Th>
              <Th>SPF</Th>
              <Th>DMARC</Th>
              <Th>Status</Th>
              <Th>{''}</Th>
            </tr>
          </thead>
          <tbody>
            {items.map(d => (
              <tr key={d.id}>
                <Td className="font-mono text-sm">{d.domain}</Td>
                <Td>{d.spf_ok ? <Check /> : <Dash />}</Td>
                <Td>{d.dmarc_ok ? <Check /> : <Dash />}</Td>
                <Td><StatusBadge status={d.verified ? 'verified' : 'pending'} /></Td>
                <Td>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      disabled={checkingId === d.id}
                      onClick={() => handleVerify(d)}
                    >
                      {checkingId === d.id ? 'Checking…' : 'Check DNS'}
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => handleRemove(d)}
                    >
                      Remove
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {items.length > 0 && (
        <div className="bg-surface-raised rounded-2xl border border-line p-5 space-y-5">
          <h2 className="text-base font-semibold text-ink">DNS records to add</h2>
          <p className="text-sm text-ink-muted">
            Add these records in your DNS provider for each domain you want to authenticate.
            Changes can take up to 48 hours to propagate — hit "Check DNS" after adding them.
          </p>

          {items.map(d => (
            <div key={d.id} className="space-y-3">
              <h3 className="text-sm font-medium text-ink">{d.domain}</h3>

              {/* SPF */}
              <div className="space-y-1">
                <p className="text-xs font-medium text-ink-muted uppercase tracking-wide">SPF — TXT record on <span className="font-mono">{d.domain}</span></p>
                <div className="flex items-start gap-2">
                  <pre className="flex-1 bg-surface rounded-lg border border-line p-3 text-xs font-mono text-ink-muted whitespace-pre-wrap break-all">
                    {`v=spf1 include:<your-smtp-provider> ~all`}
                  </pre>
                  <CopyButton value={`v=spf1 include:<your-smtp-provider> ~all`} />
                </div>
                <p className="text-xs text-ink-dim">
                  Replace <span className="font-mono">include:&lt;your-smtp-provider&gt;</span> with the include value given by your SMTP provider (e.g. <span className="font-mono">include:sendgrid.net</span>).
                </p>
              </div>

              {/* DMARC */}
              <div className="space-y-1">
                <p className="text-xs font-medium text-ink-muted uppercase tracking-wide">DMARC — TXT record on <span className="font-mono">{`_dmarc.${d.domain}`}</span></p>
                <div className="flex items-start gap-2">
                  <pre className="flex-1 bg-surface rounded-lg border border-line p-3 text-xs font-mono text-ink-muted whitespace-pre-wrap break-all">
                    {`v=DMARC1; p=none; rua=mailto:dmarc@${d.domain}`}
                  </pre>
                  <CopyButton value={`v=DMARC1; p=none; rua=mailto:dmarc@${d.domain}`} />
                </div>
                <p className="text-xs text-ink-dim">
                  <span className="font-mono">p=none</span> is a safe starting policy (monitor only). You can tighten it to <span className="font-mono">p=quarantine</span> or <span className="font-mono">p=reject</span> once you are confident all legitimate mail is aligned.
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
