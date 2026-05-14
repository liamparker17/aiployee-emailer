import { useEffect, useState } from 'react';
import { api } from '../api';
import { Table, Th, Td } from '../components/Table';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Input, Field } from '../components/Input';

interface Tenant { id: string; name: string; slug: string; created_at: string }

export default function AdminTenants() {
  const [items, setItems] = useState<Tenant[]>([]);
  const [open, setOpen] = useState(false);
  const [invite, setInvite] = useState<{ url: string } | null>(null);
  const refresh = () => api<{ tenants: Tenant[] }>('/api/admin/tenants').then(r => setItems(r.tenants));
  useEffect(() => { refresh(); }, []);
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-heading font-semibold">Tenants</h1>
        <Button onClick={() => setOpen(true)}>New tenant</Button>
      </div>
      <Table>
        <thead><tr><Th>Name</Th><Th>Slug</Th><Th>Created</Th></tr></thead>
        <tbody>{items.map(t => (
          <tr key={t.id}><Td>{t.name}</Td><Td>{t.slug}</Td><Td>{new Date(t.created_at).toLocaleString()}</Td></tr>
        ))}</tbody>
      </Table>
      <CreateModal open={open} onClose={() => setOpen(false)} onCreated={i => { setInvite(i); setOpen(false); refresh(); }} />
      <Modal open={!!invite} onClose={() => setInvite(null)} title="Admin invite link">
        <div className="space-y-3">
          <p className="text-sm text-muted">Share this link with the tenant admin. It will expire.</p>
          <pre className="bg-surface rounded-md p-3 text-xs break-all">{invite?.url}</pre>
          <div className="flex justify-end"><Button onClick={() => setInvite(null)}>Done</Button></div>
        </div>
      </Modal>
    </div>
  );
}

function CreateModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (i: { url: string }) => void }) {
  const [form, setForm] = useState({ name: '', slug: '', adminEmail: '' });
  return (
    <Modal open={open} onClose={onClose} title="New tenant">
      <form className="space-y-3" onSubmit={async e => {
        e.preventDefault();
        const r = await api<{ invite: { url: string } }>('/api/admin/tenants', { method: 'POST', body: JSON.stringify(form) });
        onCreated(r.invite);
      }}>
        <Field label="Name"><Input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Slug" hint="lowercase letters, digits, hyphen"><Input required value={form.slug} onChange={e => setForm({ ...form, slug: e.target.value })} /></Field>
        <Field label="Admin email"><Input required type="email" value={form.adminEmail} onChange={e => setForm({ ...form, adminEmail: e.target.value })} /></Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit">Create</Button>
        </div>
      </form>
    </Modal>
  );
}
