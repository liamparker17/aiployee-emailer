import { useEffect, useState } from 'react';
import { api } from '../api';
import { Table, Th, Td } from '../components/Table';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Input, Field } from '../components/Input';

interface Key { id: string; name: string; key_prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null }

export default function ApiKeys() {
  const [items, setItems] = useState<Key[]>([]);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const refresh = () => api<{ keys: Key[] }>('/api/api-keys').then(r => setItems(r.keys));
  useEffect(() => { refresh(); }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-heading font-semibold">API keys</h1>
        <Button onClick={() => setOpen(true)}>Generate</Button>
      </div>
      <Table>
        <thead><tr><Th>Name</Th><Th>Prefix</Th><Th>Last used</Th><Th>Status</Th><Th>{''}</Th></tr></thead>
        <tbody>{items.map(k => (
          <tr key={k.id}>
            <Td>{k.name}</Td><Td className="font-mono">{k.key_prefix}…</Td>
            <Td>{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'}</Td>
            <Td>{k.revoked_at ? 'revoked' : 'active'}</Td>
            <Td>{!k.revoked_at && <Button variant="danger" onClick={async () => {
              if (!confirm(`Revoke ${k.name}?`)) return;
              await api(`/api/api-keys/${k.id}`, { method: 'DELETE' }); refresh();
            }}>Revoke</Button>}</Td>
          </tr>
        ))}</tbody>
      </Table>
      <Modal open={open} onClose={() => setOpen(false)} title="Generate API key">
        <Generate onDone={k => { setShown(k); setOpen(false); refresh(); }} />
      </Modal>
      <Modal open={!!shown} onClose={() => setShown(null)} title="Copy this key now">
        <div className="space-y-3">
          <p className="text-sm text-muted">This is the only time the full key will be shown.</p>
          <pre className="bg-surface rounded-md p-3 text-xs break-all">{shown}</pre>
          <div className="flex justify-end"><Button onClick={() => setShown(null)}>Done</Button></div>
        </div>
      </Modal>
    </div>
  );
}

function Generate({ onDone }: { onDone: (plaintext: string) => void }) {
  const [name, setName] = useState('');
  return (
    <form className="space-y-3" onSubmit={async e => {
      e.preventDefault();
      const r = await api<{ plaintext: string }>('/api/api-keys', { method: 'POST', body: JSON.stringify({ name }) });
      onDone(r.plaintext);
    }}>
      <Field label="Name"><Input required value={name} onChange={e => setName(e.target.value)} /></Field>
      <div className="flex justify-end"><Button type="submit">Generate</Button></div>
    </form>
  );
}
