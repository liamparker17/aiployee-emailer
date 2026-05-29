import { useEffect, useState } from 'react';
import { ScrollText } from 'lucide-react';
import { api } from '../api';
import { Table, Th, Td } from '../components/Table';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';
import { Skeleton } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';

interface Email { id: string; to_addr: string; subject: string; status: string; created_at: string; error: string | null; message_id: string | null; body_html: string; open_count: number; click_count: number }

const STATUSES = ['', 'queued', 'sending', 'sent', 'failed', 'bounced', 'complained', 'suppressed'];

export default function EmailLog() {
  const [items, setItems] = useState<Email[]>([]);
  const [status, setStatus] = useState('');
  const [sel, setSel] = useState<Email | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const qs = new URLSearchParams(); if (status) qs.set('status', status); qs.set('limit', '200');
    setLoading(true);
    api<{ emails: Email[] }>(`/api/emails?${qs}`).then(r => { setItems(r.emails); setLoading(false); });
  }, [status]);
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
          <thead><tr><Th>Time</Th><Th>To</Th><Th>Subject</Th><Th>Status</Th><Th>Opens</Th><Th>Clicks</Th></tr></thead>
          <tbody>{items.map(e => (
            <tr key={e.id} className="cursor-pointer hover:bg-surface" onClick={() => setSel(e)}>
              <Td className="text-ink-dim">{new Date(e.created_at).toLocaleString()}</Td>
              <Td>{e.to_addr}</Td>
              <Td>{e.subject}</Td>
              <Td><StatusBadge status={e.status} /></Td>
              <Td className={e.open_count > 0 ? 'text-magenta' : 'text-ink-dim'}>{e.open_count}</Td>
              <Td className={e.click_count > 0 ? 'text-accent' : 'text-ink-dim'}>{e.click_count}</Td>
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
