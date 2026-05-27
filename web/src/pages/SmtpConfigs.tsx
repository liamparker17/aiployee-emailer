import { useEffect, useState } from 'react';
import { api } from '../api';
import { Table, Th, Td } from '../components/Table';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Input, Field } from '../components/Input';

interface Cfg { id: string; name: string; host: string; port: number; secure: boolean; username: string; from_domain: string; is_default: boolean }

export default function SmtpConfigs() {
  const [items, setItems] = useState<Cfg[]>([]);
  const [open, setOpen] = useState(false);
  const refresh = () => api<{ configs: Cfg[] }>('/api/smtp-configs').then(r => setItems(r.configs));
  useEffect(() => { refresh(); }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-heading font-semibold">SMTP configs</h1>
        <Button onClick={() => setOpen(true)}>Add</Button>
      </div>
      <Table>
        <thead><tr><Th>Name</Th><Th>Host</Th><Th>Port</Th><Th>From domain</Th><Th>{''}</Th></tr></thead>
        <tbody>{items.map(c => (
          <tr key={c.id}>
            <Td>{c.name}</Td><Td>{c.host}</Td><Td>{c.port}</Td><Td>{c.from_domain}</Td>
            <Td>
              <div className="flex gap-2 justify-end">
                <TestBtn id={c.id} />
                <Button variant="danger" onClick={async () => {
                  if (!confirm(`Delete ${c.name}?`)) return;
                  await api(`/api/smtp-configs/${c.id}`, { method: 'DELETE' }); refresh();
                }}>Delete</Button>
              </div>
            </Td>
          </tr>
        ))}</tbody>
      </Table>
      <AddModal open={open} onClose={() => { setOpen(false); refresh(); }} />
    </div>
  );
}

function TestBtn({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  return <Button variant="ghost" disabled={busy} onClick={async () => {
    const to = prompt('Send a test email to:');
    if (!to) return;
    setBusy(true);
    try { await api(`/api/smtp-configs/${id}/test`, { method: 'POST', body: JSON.stringify({ to }) }); alert('Sent.'); }
    catch (e: unknown) { alert('Failed: ' + (e as Error).message); }
    finally { setBusy(false); }
  }}>Test</Button>;
}

function AddModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form, setForm] = useState({ name: '', host: '', port: 587, secure: false, username: '', password: '', fromDomain: '', isDefault: false });
  // Gmail uses STARTTLS on 587; the password must be a 16-char App Password (2-Step Verification required).
  const applyGmailPreset = () => setForm(f => ({ ...f, host: 'smtp.gmail.com', port: 587, secure: false }));
  const isGmail = form.host === 'smtp.gmail.com';
  return (
    <Modal open={open} onClose={onClose} title="Add SMTP config">
      <form className="space-y-3" onSubmit={async e => {
        e.preventDefault();
        await api('/api/smtp-configs', { method: 'POST', body: JSON.stringify(form) });
        onClose();
      }}>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted">Quick fill:</span>
          <Button variant="ghost" type="button" onClick={applyGmailPreset}>Gmail</Button>
        </div>
        {isGmail && (
          <div className="rounded-md border border-line bg-bg px-3 py-2 text-xs text-muted space-y-1">
            <p className="font-medium text-ink">Gmail caveats</p>
            <p>From address is rewritten to your Gmail account unless the sender's email is a verified “Send mail as” alias.</p>
            <p>No delivery/bounce webhooks — the suppression list and email events won't update for Gmail sends.</p>
            <p>Daily send limits apply (~500/day free, ~2,000/day Workspace).</p>
          </div>
        )}
        <Field label="Name"><Input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Host"><Input required value={form.host} onChange={e => setForm({ ...form, host: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Port"><Input type="number" required value={form.port} onChange={e => setForm({ ...form, port: Number(e.target.value) })} /></Field>
          <Field label="Secure (TLS)"><input type="checkbox" checked={form.secure} onChange={e => setForm({ ...form, secure: e.target.checked })} /></Field>
        </div>
        <Field label="Username" hint={isGmail ? 'Your full Gmail address (e.g. you@gmail.com)' : undefined}><Input required value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} /></Field>
        <Field label="Password" hint={isGmail ? 'Use a Google App Password (2-Step Verification required) — not your login password' : undefined}><Input required type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></Field>
        <Field label="From domain" hint="e.g. aiployee.co.za"><Input required value={form.fromDomain} onChange={e => setForm({ ...form, fromDomain: e.target.value })} /></Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit">Save</Button>
        </div>
      </form>
    </Modal>
  );
}
