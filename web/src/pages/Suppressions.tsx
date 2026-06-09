import { useEffect, useState } from 'react';
import { ShieldBan } from 'lucide-react';
import { api } from '@aiployee/ui';
import { Table, Th, Td } from '@aiployee/ui';
import { Button } from '@aiployee/ui';
import { Modal } from '@aiployee/ui';
import { Input, Field } from '@aiployee/ui';
import { PageHeader } from '@aiployee/ui';
import { EmptyState } from '@aiployee/ui';
import { Skeleton } from '@aiployee/ui';
import { useToast } from '@aiployee/ui';

interface Sup { address: string; reason: string; created_at: string }

export default function Suppressions() {
  const [items, setItems] = useState<Sup[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const toast = useToast();
  const refresh = () => {
    setLoading(true);
    api<{ suppressions: Sup[] }>('/api/suppressions').then(r => { setItems(r.suppressions); setLoading(false); });
  };
  useEffect(() => { refresh(); }, []);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Suppressions"
        actions={<Button onClick={() => setOpen(true)}>Add</Button>}
      />
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-9" />)}
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={ShieldBan} title="No suppressions" />
      ) : (
        <Table>
          <thead><tr><Th>Address</Th><Th>Reason</Th><Th>Added</Th><Th>{''}</Th></tr></thead>
          <tbody>{items.map(s => (
            <tr key={s.address}>
              <Td>{s.address}</Td>
              <Td className="text-ink-muted">{s.reason}</Td>
              <Td className="text-ink-dim">{new Date(s.created_at).toLocaleString()}</Td>
              <Td><Button variant="danger" onClick={async () => {
                if (!confirm(`Remove ${s.address}?`)) return;
                await api(`/api/suppressions/${encodeURIComponent(s.address)}`, { method: 'DELETE' })
                  .then(() => { toast.success(`Removed ${s.address}`); refresh(); })
                  .catch(() => toast.error('Failed to remove suppression'));
              }}>Remove</Button></Td>
            </tr>
          ))}</tbody>
        </Table>
      )}
      <AddModal open={open} onClose={() => { setOpen(false); refresh(); }} />
    </div>
  );
}

function AddModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [address, setAddress] = useState('');
  const toast = useToast();
  return (
    <Modal open={open} onClose={onClose} title="Add suppression">
      <form className="space-y-3" onSubmit={async e => {
        e.preventDefault();
        await api('/api/suppressions', { method: 'POST', body: JSON.stringify({ address, reason: 'manual' }) })
          .then(() => { toast.success(`Added ${address}`); onClose(); })
          .catch(() => toast.error('Failed to add suppression'));
      }}>
        <Field label="Email address"><Input required type="email" value={address} onChange={e => setAddress(e.target.value)} /></Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit">Add</Button>
        </div>
      </form>
    </Modal>
  );
}
