import { useEffect, useState } from 'react';
import { api } from '../api';
import { Table, Th, Td } from '../components/Table';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Input, Field } from '../components/Input';

interface U { id: string; email: string; role: string }

export default function Users() {
  const [items, setItems] = useState<U[]>([]);
  const [open, setOpen] = useState(false);
  const [invite, setInvite] = useState<{ url: string } | null>(null);
  const refresh = () => api<{ users: U[] }>('/api/users').then(r => setItems(r.users));
  useEffect(() => { refresh(); }, []);
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-heading font-semibold">Users</h1>
        <Button onClick={() => setOpen(true)}>Invite user</Button>
      </div>
      <Table>
        <thead><tr><Th>Email</Th><Th>Role</Th></tr></thead>
        <tbody>{items.map(u => (
          <tr key={u.id}><Td>{u.email}</Td><Td>{u.role}</Td></tr>
        ))}</tbody>
      </Table>
      <InviteModal open={open} onClose={() => { setOpen(false); refresh(); }} onInvited={i => { setInvite(i); setOpen(false); refresh(); }} />
      <Modal open={!!invite} onClose={() => setInvite(null)} title="Invite link">
        <div className="space-y-3">
          <p className="text-sm text-muted">Share this link with the new user. It will expire.</p>
          <pre className="bg-surface rounded-md p-3 text-xs break-all">{invite?.url}</pre>
          <div className="flex justify-end"><Button onClick={() => setInvite(null)}>Done</Button></div>
        </div>
      </Modal>
    </div>
  );
}

function InviteModal({ open, onClose, onInvited }: { open: boolean; onClose: () => void; onInvited: (i: { url: string }) => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'tenant_admin' | 'tenant_user'>('tenant_user');
  return (
    <Modal open={open} onClose={onClose} title="Invite user">
      <form className="space-y-3" onSubmit={async e => {
        e.preventDefault();
        const r = await api<{ invite: { url: string } }>('/api/users/invite', { method: 'POST', body: JSON.stringify({ email, role }) });
        onInvited(r.invite);
      }}>
        <Field label="Email"><Input required type="email" value={email} onChange={e => setEmail(e.target.value)} /></Field>
        <Field label="Role">
          <select className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm"
                  value={role} onChange={e => setRole(e.target.value as 'tenant_admin' | 'tenant_user')}>
            <option value="tenant_user">tenant_user</option>
            <option value="tenant_admin">tenant_admin</option>
          </select>
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit">Invite</Button>
        </div>
      </form>
    </Modal>
  );
}
