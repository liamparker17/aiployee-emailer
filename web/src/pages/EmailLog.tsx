import { useEffect, useState } from 'react';
import { api } from '../api';
import { Table, Th, Td } from '../components/Table';
import { Modal } from '../components/Modal';

interface Email { id: string; to_addr: string; subject: string; status: string; created_at: string; error: string | null; message_id: string | null; body_html: string }

const STATUSES = ['', 'queued', 'sending', 'sent', 'failed', 'bounced', 'complained', 'suppressed'];

export default function EmailLog() {
  const [items, setItems] = useState<Email[]>([]);
  const [status, setStatus] = useState('');
  const [sel, setSel] = useState<Email | null>(null);
  useEffect(() => {
    const qs = new URLSearchParams(); if (status) qs.set('status', status); qs.set('limit', '200');
    api<{ emails: Email[] }>(`/api/emails?${qs}`).then(r => setItems(r.emails));
  }, [status]);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-heading font-semibold">Email log</h1>
      <select className="rounded-md border border-line px-2 py-1 text-sm" value={status} onChange={e => setStatus(e.target.value)}>
        {STATUSES.map(s => <option key={s} value={s}>{s || 'any status'}</option>)}
      </select>
      <Table>
        <thead><tr><Th>Time</Th><Th>To</Th><Th>Subject</Th><Th>Status</Th></tr></thead>
        <tbody>{items.map(e => (
          <tr key={e.id} className="cursor-pointer hover:bg-surface" onClick={() => setSel(e)}>
            <Td>{new Date(e.created_at).toLocaleString()}</Td><Td>{e.to_addr}</Td><Td>{e.subject}</Td><Td>{e.status}</Td>
          </tr>
        ))}</tbody>
      </Table>
      <Modal open={!!sel} onClose={() => setSel(null)} title="Email detail">
        {sel && (
          <div className="space-y-2 text-sm">
            <div><span className="text-muted">To:</span> {sel.to_addr}</div>
            <div><span className="text-muted">Subject:</span> {sel.subject}</div>
            <div><span className="text-muted">Status:</span> {sel.status}</div>
            <div><span className="text-muted">Message-ID:</span> {sel.message_id ?? '—'}</div>
            {sel.error && <div className="text-red-600">{sel.error}</div>}
            <iframe className="w-full h-64 bg-bg border border-line rounded-md" srcDoc={sel.body_html} />
          </div>
        )}
      </Modal>
    </div>
  );
}
