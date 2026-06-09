import { useEffect, useState } from 'react';
import { ScrollText } from 'lucide-react';
import { api } from '../api';
import { Table, Th, Td } from '../components/Table';
import { Modal } from '../components/Modal';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';
import { Skeleton } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { useToast } from '../components/Toast';

interface Email { id: string; to_addr: string; subject: string; status: string; created_at: string; scheduled_for: string | null; error: string | null; message_id: string | null; body_html: string; open_count: number; click_count: number }

const STATUSES = ['', 'queued', 'sending', 'sent', 'failed', 'bounced', 'complained', 'suppressed', 'canceled'];

export default function EmailLog() {
  const toast = useToast();
  const [items, setItems] = useState<Email[]>([]);
  const [status, setStatus] = useState('');
  const [sel, setSel] = useState<Email | null>(null);
  const [loading, setLoading] = useState(false);
  const load = () => {
    const qs = new URLSearchParams(); if (status) qs.set('status', status); qs.set('limit', '200');
    setLoading(true);
    api<{ emails: Email[] }>(`/api/emails?${qs}`).then(r => { setItems(r.emails); setLoading(false); });
  };
  useEffect(() => { load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function cancel(ev: React.MouseEvent, id: string) {
    ev.stopPropagation();
    if (!confirm('Cancel this scheduled email?')) return;
    try { await api(`/api/emails/${id}/cancel`, { method: 'POST' }); toast.success('Canceled'); load(); }
    catch (err: unknown) { toast.error('Cancel failed: ' + (err as Error).message); }
  }
  return (
    <div className="space-y-4">
      <PageHeader title="Email log" />
      <div className="bg-surface border border-line rounded-2xl px-4 py-3">
        <select
          className="rounded-btn border border-line bg-surface-raised text-ink px-2 py-1 text-sm"
          value={status}
          onChange={e => setStatus(e.target.value)}
        >
          {STATUSES.map(s => <option key={s} value={s}>{s || 'any status'}</option>)}
        </select>
      </div>
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-9" />)}
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={ScrollText} title="No emails logged" />
      ) : (
        <Table>
          <thead><tr><Th>Time</Th><Th>To</Th><Th>Subject</Th><Th>Status</Th><Th>Scheduled</Th><Th>Opens</Th><Th>Clicks</Th><Th>{''}</Th></tr></thead>
          <tbody>{items.map(e => (
            <tr key={e.id} className="cursor-pointer hover:bg-surface" onClick={() => setSel(e)}>
              <Td className="text-ink-dim">{new Date(e.created_at).toLocaleString()}</Td>
              <Td>{e.to_addr}</Td>
              <Td>{e.subject}</Td>
              <Td><StatusBadge status={e.status} /></Td>
              <Td className="text-ink-dim">{e.scheduled_for ? new Date(e.scheduled_for).toLocaleString() : '—'}</Td>
              <Td className={e.open_count > 0 ? 'text-magenta' : 'text-ink-dim'}>{e.open_count}</Td>
              <Td className={e.click_count > 0 ? 'text-accent' : 'text-ink-dim'}>{e.click_count}</Td>
              <Td>{e.status === 'queued' && (
                <span onClick={ev => ev.stopPropagation()}>
                  <Button variant="ghost" onClick={ev => cancel(ev, e.id)}>Cancel</Button>
                </span>
              )}</Td>
            </tr>
          ))}</tbody>
        </Table>
      )}
      <Modal open={!!sel} onClose={() => setSel(null)} title="Email detail">
        {sel && (
          <div className="space-y-2 text-sm">
            <div><span className="text-ink-muted">To:</span> <span className="text-ink">{sel.to_addr}</span></div>
            <div><span className="text-ink-muted">Subject:</span> <span className="text-ink">{sel.subject}</span></div>
            <div><span className="text-ink-muted">Status:</span> <StatusBadge status={sel.status} /></div>
            <div><span className="text-ink-muted">Message-ID:</span> <span className="text-ink-dim">{sel.message_id ?? '—'}</span></div>
            {sel.error && <div className="text-error">{sel.error}</div>}
            <iframe className="w-full h-64 bg-surface border border-line rounded-md" srcDoc={sel.body_html} />
          </div>
        )}
      </Modal>
    </div>
  );
}
