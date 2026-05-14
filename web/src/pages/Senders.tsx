import { useEffect, useState } from 'react';
import { api } from '../api';
import { Table, Th, Td } from '../components/Table';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Input, Field } from '../components/Input';

interface Sender { id: string; email: string; display_name: string; reply_to: string | null; smtp_config_id: string; is_default: boolean }
interface Cfg { id: string; name: string; from_domain: string }

export default function Senders() {
  const [items, setItems] = useState<Sender[]>([]);
  const [configs, setConfigs] = useState<Cfg[]>([]);
  const [open, setOpen] = useState(false);
  const refresh = () => Promise.all([
    api<{ senders: Sender[] }>('/api/senders').then(r => setItems(r.senders)),
    api<{ configs: Cfg[] }>('/api/smtp-configs').then(r => setConfigs(r.configs)),
  ]);
  useEffect(() => { refresh(); }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-heading font-semibold">Senders</h1>
        <Button onClick={() => setOpen(true)}>Add sender</Button>
      </div>
      <Table>
        <thead><tr><Th>Email</Th><Th>Display name</Th><Th>Reply-to</Th><Th>SMTP</Th><Th>{''}</Th></tr></thead>
        <tbody>{items.map(s => (
          <tr key={s.id}>
            <Td>{s.email}</Td><Td>{s.display_name}</Td><Td>{s.reply_to ?? '—'}</Td>
            <Td>{configs.find(c => c.id === s.smtp_config_id)?.name ?? s.smtp_config_id.slice(0,8)}</Td>
            <Td><Button variant="danger" onClick={async () => {
              if (!confirm(`Delete ${s.email}?`)) return;
              await api(`/api/senders/${s.id}`, { method: 'DELETE' }); refresh();
            }}>Delete</Button></Td>
          </tr>
        ))}</tbody>
      </Table>
      <AddModal open={open} onClose={() => { setOpen(false); refresh(); }} configs={configs} />
    </div>
  );
}

function AddModal({ open, onClose, configs }: { open: boolean; onClose: () => void; configs: Cfg[] }) {
  const [form, setForm] = useState({ email: '', displayName: '', replyTo: '', smtpConfigId: configs[0]?.id ?? '', isDefault: false });
  return (
    <Modal open={open} onClose={onClose} title="Add sender">
      <form className="space-y-3" onSubmit={async e => {
        e.preventDefault();
        await api('/api/senders', {
          method: 'POST',
          body: JSON.stringify({ ...form, replyTo: form.replyTo || null, smtpConfigId: form.smtpConfigId }),
        });
        onClose();
      }}>
        <Field label="Email"><Input required type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Display name"><Input required value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} /></Field>
        <Field label="Reply-to (optional)"><Input type="email" value={form.replyTo} onChange={e => setForm({ ...form, replyTo: e.target.value })} /></Field>
        <Field label="SMTP config">
          <select required className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm"
                  value={form.smtpConfigId} onChange={e => setForm({ ...form, smtpConfigId: e.target.value })}>
            {configs.map(c => <option key={c.id} value={c.id}>{c.name} ({c.from_domain})</option>)}
          </select>
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit">Save</Button>
        </div>
      </form>
    </Modal>
  );
}
