import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2 } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Table, Th, Td } from '../components/Table';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Input, Field } from '../components/Input';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';
import { useToast } from '../components/Toast';

interface Tenant { id: string; name: string; slug: string; created_at: string }

export default function AdminTenants() {
  const { logout } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [items, setItems] = useState<Tenant[]>([]);
  const [open, setOpen] = useState(false);
  const [invite, setInvite] = useState<{ url: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = () => {
    setLoading(true);
    api<{ tenants: Tenant[] }>('/api/admin/tenants').then(r => { setItems(r.tenants); setLoading(false); });
  };
  useEffect(() => { refresh(); }, []);

  return (
    <div className="min-h-full bg-surface">
      <header className="border-b border-line px-6 py-3 flex items-center justify-between bg-surface-raised">
        <a href="/" className="text-sm text-ink-muted hover:text-ink transition">← All tenants</a>
        <button
          onClick={async () => { await logout(); nav('/login'); }}
          className="text-sm text-ink-muted hover:text-ink transition">
          Sign out
        </button>
      </header>

      <div className="p-8 max-w-5xl space-y-6">
        <PageHeader
          title="Tenants"
          actions={<Button onClick={() => setOpen(true)}>New tenant</Button>}
        />

        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={Building2} title="No tenants yet" description="Create your first tenant to get started." />
        ) : (
          <Table>
            <thead><tr><Th>Name</Th><Th>Slug</Th><Th>Created</Th></tr></thead>
            <tbody>{items.map(t => (
              <tr key={t.id}>
                <Td>{t.name}</Td>
                <Td>{t.slug}</Td>
                <Td>{new Date(t.created_at).toLocaleString()}</Td>
              </tr>
            ))}</tbody>
          </Table>
        )}

        <CreateModal
          open={open}
          onClose={() => setOpen(false)}
          onCreated={i => { setInvite(i); setOpen(false); refresh(); toast.success('Tenant created'); }}
          onError={() => toast.error('Failed to create tenant')}
        />

        <Modal open={!!invite} onClose={() => setInvite(null)} title="Admin invite link">
          <div className="space-y-3">
            <p className="text-sm text-ink-muted">Share this link with the tenant admin. It will expire.</p>
            <pre className="bg-surface-raised rounded-md p-3 text-xs break-all text-ink border border-line">{invite?.url}</pre>
            <div className="flex justify-end"><Button onClick={() => setInvite(null)}>Done</Button></div>
          </div>
        </Modal>
      </div>
    </div>
  );
}

function CreateModal({ open, onClose, onCreated, onError }: {
  open: boolean;
  onClose: () => void;
  onCreated: (i: { url: string }) => void;
  onError: () => void;
}) {
  const [form, setForm] = useState({ name: '', slug: '', adminEmail: '' });
  return (
    <Modal open={open} onClose={onClose} title="New tenant">
      <form className="space-y-3" onSubmit={async e => {
        e.preventDefault();
        try {
          const r = await api<{ invite: { url: string } }>('/api/admin/tenants', { method: 'POST', body: JSON.stringify(form) });
          onCreated(r.invite);
        } catch {
          onError();
        }
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
