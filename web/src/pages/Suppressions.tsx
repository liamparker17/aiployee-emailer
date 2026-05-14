import { useEffect, useState } from 'react';
import { api } from '../api';
import { Table, Th, Td } from '../components/Table';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Input, Field } from '../components/Input';

interface Sup { address: string; reason: string; created_at: string }

export default function Suppressions() {
  const [items, setItems] = useState<Sup[]>([]);
  const [open, setOpen] = useState(false);
  const refresh = () => api<{ suppressions: Sup[] }>('/api/suppressions').then(r => setItems(r.suppressions));
  useEffect(() => { refresh(); }, []);
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-heading font-semibold">Suppressions</h1>
        <Button onClick={() => setOpen(true)}>Add</Button>
      </div>
      <Table>
        <thead><tr><Th>Address</Th><Th>Reason</Th><Th>Added</Th><Th>{''}</Th></tr></thead>
        <tbody>{items.map(s => (
          <tr key={s.address}>
            <Td>{s.address}</Td><Td>{s.reason}</Td><Td>{new Date(s.created_at).toLocaleString()}</Td>
            <Td><Button variant="danger" onClick={async () => {
              if (!confirm(`Remove ${s.address}?`)) return;
              await api(`/api/suppressions/${encodeURIComponent(s.address)}`, { method: 'DELETE' }); refresh();
            }}>Remove</Button></Td>
          </tr>
        ))}</tbody>
      </Table>
      <AddModal open={open} onClose={() => { setOpen(false); refresh(); }} />
    </div>
  );
}

function AddModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [address, setAddress] = useState('');
  return (
    <Modal open={open} onClose={onClose} title="Add suppression">
      <form className="space-y-3" onSubmit={async e => {
        e.preventDefault();
        await api('/api/suppressions', { method: 'POST', body: JSON.stringify({ address, reason: 'manual' }) });
        onClose();
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
