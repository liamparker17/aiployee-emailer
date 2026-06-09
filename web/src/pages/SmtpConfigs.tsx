import { useEffect, useState } from 'react';
import { Server } from 'lucide-react';
import { api } from '@aiployee/ui';
import { Table, Th, Td } from '@aiployee/ui';
import { Button } from '@aiployee/ui';
import { Modal } from '@aiployee/ui';
import { Input, Field } from '@aiployee/ui';
import { PageHeader } from '@aiployee/ui';
import { EmptyState } from '@aiployee/ui';
import { Skeleton } from '@aiployee/ui';
import { useToast } from '@aiployee/ui';

interface Cfg { id: string; name: string; host: string; port: number; secure: boolean; username: string; from_domain: string; is_default: boolean }

export default function SmtpConfigs() {
  const [items, setItems] = useState<Cfg[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const refresh = () => api<{ configs: Cfg[] }>('/api/smtp-configs').then(r => { setItems(r.configs); setLoading(false); });
  useEffect(() => { refresh(); }, []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="SMTP configs"
        subtitle="Manage the SMTP servers used to send mail."
        actions={<Button onClick={() => setOpen(true)}>Add</Button>}
      />
      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map(i => <Skeleton key={i} className="h-9" />)}
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={Server} title="No SMTP configs" description="Add an SMTP server to send mail." />
      ) : (
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
                    try {
                      await api(`/api/smtp-configs/${c.id}`, { method: 'DELETE' });
                      toast.success('Config deleted.');
                      refresh();
                    } catch (e: unknown) {
                      toast.error('Delete failed: ' + (e as Error).message);
                    }
                  }}>Delete</Button>
                </div>
              </Td>
            </tr>
          ))}</tbody>
        </Table>
      )}
      <AddModal open={open} onClose={() => { setOpen(false); refresh(); }} />
    </div>
  );
}

function TestBtn({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return <Button variant="ghost" disabled={busy} onClick={async () => {
    const to = prompt('Send a test email to:');
    if (!to) return;
    setBusy(true);
    try {
      await api(`/api/smtp-configs/${id}/test`, { method: 'POST', body: JSON.stringify({ to }) });
      toast.success('Test email sent.');
    }
    catch (e: unknown) { toast.error('Failed: ' + (e as Error).message); }
    finally { setBusy(false); }
  }}>Test</Button>;
}

function AddModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form, setForm] = useState({ name: '', host: '', port: 587, secure: false, username: '', password: '', fromDomain: '', isDefault: false });
  const toast = useToast();
  // Presets fill host/port/secure. Both Gmail and Microsoft use STARTTLS on 587.
  const applyPreset = (p: 'gmail' | 'outlook') => setForm(f => ({
    ...f,
    host: p === 'gmail' ? 'smtp.gmail.com' : 'smtp.office365.com',
    port: 587, secure: false,
  }));
  const provider = form.host === 'smtp.gmail.com' ? 'gmail'
    : form.host === 'smtp.office365.com' ? 'outlook' : null;
  return (
    <Modal open={open} onClose={onClose} title="Add SMTP config">
      <form className="space-y-3" onSubmit={async e => {
        e.preventDefault();
        try {
          await api('/api/smtp-configs', { method: 'POST', body: JSON.stringify(form) });
          toast.success('SMTP config saved.');
          onClose();
        } catch (e: unknown) {
          toast.error('Save failed: ' + (e as Error).message);
        }
      }}>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-ink-muted">Quick fill:</span>
          <Button variant="ghost" type="button" onClick={() => applyPreset('gmail')}>Gmail</Button>
          <Button variant="ghost" type="button" onClick={() => applyPreset('outlook')}>Outlook</Button>
        </div>
        {provider === 'gmail' && (
          <div className="rounded-md border border-line bg-surface-raised px-3 py-2 text-xs text-ink-muted space-y-1">
            <p className="font-medium text-ink">Gmail caveats</p>
            <p>From address is rewritten to your Gmail account unless the sender's email is a verified "Send mail as" alias.</p>
            <p>No delivery/bounce webhooks — the suppression list and email events won't update for Gmail sends.</p>
            <p>Daily send limits apply (~500/day free, ~2,000/day Workspace).</p>
          </div>
        )}
        {provider === 'outlook' && (
          <div className="rounded-md border border-line bg-surface-raised px-3 py-2 text-xs text-ink-muted space-y-1">
            <p className="font-medium text-ink">Outlook / Microsoft 365 caveats</p>
            <p>Host is <code>smtp.office365.com</code> for Microsoft 365; personal Outlook.com uses <code>smtp-mail.outlook.com</code>.</p>
            <p>The mailbox must have SMTP AUTH enabled; if it has MFA, use an app password (not the normal password).</p>
            <p>From must be the signed-in mailbox or a configured alias. No delivery/bounce webhooks — suppression won't update.</p>
          </div>
        )}
        <Field label="Name"><Input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Host"><Input required value={form.host} onChange={e => setForm({ ...form, host: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Port"><Input type="number" required value={form.port} onChange={e => setForm({ ...form, port: Number(e.target.value) })} /></Field>
          <Field label="Secure (TLS)"><input type="checkbox" checked={form.secure} onChange={e => setForm({ ...form, secure: e.target.checked })} /></Field>
        </div>
        <Field label="Username" hint={provider === 'gmail' ? 'Your full Gmail address (e.g. you@gmail.com)' : provider === 'outlook' ? 'Your full Outlook / Microsoft 365 email address' : undefined}><Input required value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} /></Field>
        <Field label="Password" hint={provider === 'gmail' ? 'Use a Google App Password (2-Step Verification required) — not your login password' : provider === 'outlook' ? 'If the mailbox has MFA, use an app password — not your normal password' : undefined}><Input required type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></Field>
        <Field label="From domain" hint="e.g. aiployee.co.za"><Input required value={form.fromDomain} onChange={e => setForm({ ...form, fromDomain: e.target.value })} /></Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit">Save</Button>
        </div>
      </form>
    </Modal>
  );
}
