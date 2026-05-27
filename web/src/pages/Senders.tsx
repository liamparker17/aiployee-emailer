import { useEffect, useState, type FormEvent } from 'react';
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
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [mode, setMode] = useState<'existing' | 'new'>('new');
  const [smtpConfigId, setSmtpConfigId] = useState('');
  const [smtp, setSmtp] = useState({ host: '', port: 587, secure: false, username: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Default to an existing connection when the tenant has one; otherwise jump
  // straight to creating one inline so there's never an empty, dead-end dropdown.
  useEffect(() => {
    if (!open) return;
    setMode(configs.length > 0 ? 'existing' : 'new');
    setSmtpConfigId(configs[0]?.id ?? '');
    setErr(null);
  }, [open, configs]);

  const provider = smtp.host === 'smtp.gmail.com' ? 'gmail' : smtp.host === 'smtp.office365.com' ? 'outlook' : null;
  const applyPreset = (p: 'gmail' | 'outlook') => setSmtp(s => ({
    ...s, host: p === 'gmail' ? 'smtp.gmail.com' : 'smtp.office365.com', port: 587, secure: false,
  }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      let configId = smtpConfigId;
      if (mode === 'new') {
        const domain = email.split('@')[1] ?? '';
        const r = await api<{ config: { id: string } }>('/api/smtp-configs', {
          method: 'POST',
          body: JSON.stringify({
            name: `${smtp.username || 'SMTP'} (${smtp.host})`,
            host: smtp.host, port: smtp.port, secure: smtp.secure,
            username: smtp.username, password: smtp.password, fromDomain: domain,
          }),
        });
        configId = r.config.id;
      }
      await api('/api/senders', {
        method: 'POST',
        body: JSON.stringify({ email, displayName, replyTo: replyTo || null, smtpConfigId: configId }),
      });
      onClose();
    } catch (e) {
      setErr((e as Error).message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const selectClass = 'w-full rounded-md border border-line bg-bg px-3 py-2 text-sm';

  return (
    <Modal open={open} onClose={onClose} title="Add sender">
      <form className="space-y-3" onSubmit={submit}>
        <Field label="Email"><Input required type="email" value={email} onChange={e => setEmail(e.target.value)} /></Field>
        <Field label="Display name"><Input required value={displayName} onChange={e => setDisplayName(e.target.value)} /></Field>
        <Field label="Reply-to (optional)"><Input type="email" value={replyTo} onChange={e => setReplyTo(e.target.value)} /></Field>

        <div className="border-t border-line pt-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Email connection (SMTP)</span>
            {configs.length > 0 && (
              <div className="flex gap-1 text-xs">
                <button type="button" onClick={() => setMode('existing')}
                  className={`px-2 py-1 rounded ${mode === 'existing' ? 'bg-surface text-ink font-medium' : 'text-muted'}`}>Use existing</button>
                <button type="button" onClick={() => setMode('new')}
                  className={`px-2 py-1 rounded ${mode === 'new' ? 'bg-surface text-ink font-medium' : 'text-muted'}`}>New connection</button>
              </div>
            )}
          </div>

          {mode === 'existing' ? (
            <Field label="Connection">
              <select required className={selectClass} value={smtpConfigId} onChange={e => setSmtpConfigId(e.target.value)}>
                {configs.map(c => <option key={c.id} value={c.id}>{c.name} ({c.from_domain})</option>)}
              </select>
            </Field>
          ) : (
            <>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted">Quick fill:</span>
                <Button variant="ghost" type="button" onClick={() => applyPreset('gmail')}>Gmail</Button>
                <Button variant="ghost" type="button" onClick={() => applyPreset('outlook')}>Outlook</Button>
              </div>
              <Field label="Host"><Input required value={smtp.host} onChange={e => setSmtp({ ...smtp, host: e.target.value })} /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Port"><Input type="number" required value={smtp.port} onChange={e => setSmtp({ ...smtp, port: Number(e.target.value) })} /></Field>
                <Field label="Secure (TLS)"><input type="checkbox" checked={smtp.secure} onChange={e => setSmtp({ ...smtp, secure: e.target.checked })} /></Field>
              </div>
              <Field label="Username" hint={provider === 'gmail' ? 'Your full Gmail address' : provider === 'outlook' ? 'Your full Outlook / Microsoft 365 address' : undefined}>
                <Input required value={smtp.username} onChange={e => setSmtp({ ...smtp, username: e.target.value })} />
              </Field>
              <Field label="Password" hint={provider ? 'Use an app password if the account has 2-step / MFA enabled' : undefined}>
                <Input required type="password" value={smtp.password} onChange={e => setSmtp({ ...smtp, password: e.target.value })} />
              </Field>
            </>
          )}
        </div>

        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
        </div>
      </form>
    </Modal>
  );
}
