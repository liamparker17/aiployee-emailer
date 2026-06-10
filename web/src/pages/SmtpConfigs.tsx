import { useEffect, useState } from 'react';
import { Server, Inbox } from 'lucide-react';
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
interface ImapCfg { id: string; host: string; port: number; secure: boolean; username: string; enabled: boolean; last_error: string | null }

export default function SmtpConfigs() {
  const [items, setItems] = useState<Cfg[]>([]);
  const [imapItems, setImapItems] = useState<ImapCfg[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [m365For, setM365For] = useState<Cfg | null>(null);
  const toast = useToast();
  const refresh = () => Promise.all([
    api<{ configs: Cfg[] }>('/api/smtp-configs').then(r => setItems(r.configs)),
    api<{ configs: ImapCfg[] }>('/api/imap-configs').then(r => setImapItems(r.configs)),
  ]).then(() => setLoading(false));
  useEffect(() => { refresh(); }, []);

  const monitoredUsers = new Set(imapItems.map(c => c.username.toLowerCase()));

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
                  {monitoredUsers.has(c.username.toLowerCase()) ? (
                    <Button variant="ghost" disabled>Monitored</Button>
                  ) : isM365Host(c.host) ? (
                    // Microsoft killed password IMAP — M365 mailboxes connect via device-code OAuth.
                    <Button variant="ghost" onClick={() => setM365For(c)}>Monitor inbox</Button>
                  ) : (
                    <Button variant="ghost" onClick={async () => {
                      try {
                        await api('/api/imap-configs', { method: 'POST', body: JSON.stringify({ smtpConfigId: c.id }) });
                        toast.success('Inbox monitoring enabled — replies will sync every few minutes.');
                        refresh();
                      } catch (e: unknown) {
                        toast.error('Enable failed: ' + (e as Error).message);
                      }
                    }}>Monitor inbox</Button>
                  )}
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
      <div className="space-y-3 pt-4">
        <PageHeader
          title="Inbox monitoring"
          subtitle="Mailboxes read over IMAP so campaign replies flow into the system for Abe to analyze."
        />
        {!loading && imapItems.length === 0 ? (
          <EmptyState icon={Inbox} title="No monitored inboxes" description="Use “Monitor inbox” on an SMTP config to start syncing its replies." />
        ) : (
          <Table>
            <thead><tr><Th>Mailbox</Th><Th>IMAP host</Th><Th>Status</Th><Th>{''}</Th></tr></thead>
            <tbody>{imapItems.map(c => (
              <tr key={c.id}>
                <Td>{c.username}</Td>
                <Td>{c.host}</Td>
                <Td>
                  {c.last_error
                    ? <span className="text-red-600 text-xs" title={c.last_error}>Error: {c.last_error.slice(0, 60)}</span>
                    : c.enabled ? 'Syncing' : 'Paused'}
                </Td>
                <Td>
                  <div className="flex gap-2 justify-end">
                    <ImapTestBtn id={c.id} />
                    <Button variant="ghost" onClick={async () => {
                      try {
                        await api(`/api/imap-configs/${c.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !c.enabled }) });
                        refresh();
                      } catch (e: unknown) { toast.error('Update failed: ' + (e as Error).message); }
                    }}>{c.enabled ? 'Pause' : 'Resume'}</Button>
                    <Button variant="danger" onClick={async () => {
                      if (!confirm(`Stop monitoring ${c.username}?`)) return;
                      try {
                        await api(`/api/imap-configs/${c.id}`, { method: 'DELETE' });
                        toast.success('Inbox monitoring removed.');
                        refresh();
                      } catch (e: unknown) { toast.error('Delete failed: ' + (e as Error).message); }
                    }}>Remove</Button>
                  </div>
                </Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </div>
      <AddModal open={open} onClose={() => { setOpen(false); refresh(); }} />
      <M365ConnectModal cfg={m365For} onClose={() => { setM365For(null); refresh(); }} />
    </div>
  );
}

function isM365Host(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'smtp.office365.com' || h === 'smtp-mail.outlook.com';
}

function M365ConnectModal({ cfg, onClose }: { cfg: Cfg | null; onClose: () => void }) {
  const [code, setCode] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const [status, setStatus] = useState<'starting' | 'waiting' | 'done' | 'error'>('starting');
  const [error, setError] = useState('');
  const toast = useToast();

  useEffect(() => {
    if (!cfg) return;
    setCode(null); setStatus('starting'); setError('');
    let cancelled = false;
    let timer: number | undefined;
    interface StartRes { username: string; userCode: string; verificationUri: string; deviceCode: string; intervalSeconds: number }
    api<StartRes>('/api/imap-configs/oauth/start', { method: 'POST', body: JSON.stringify({ smtpConfigId: cfg.id }) })
      .then(r => {
        if (cancelled) return;
        setCode({ userCode: r.userCode, verificationUri: r.verificationUri });
        setStatus('waiting');
        const poll = async () => {
          if (cancelled) return;
          try {
            const c = await api<{ pending?: boolean }>('/api/imap-configs/oauth/complete', {
              method: 'POST',
              body: JSON.stringify({ deviceCode: r.deviceCode, username: r.username }),
            });
            if (cancelled) return;
            if (c.pending) { timer = window.setTimeout(poll, Math.max(2, r.intervalSeconds) * 1000); return; }
            setStatus('done');
            toast.success('Mailbox connected — replies will sync every few minutes.');
          } catch (e: unknown) {
            if (cancelled) return;
            setStatus('error'); setError((e as Error).message);
          }
        };
        timer = window.setTimeout(poll, Math.max(2, r.intervalSeconds) * 1000);
      })
      .catch((e: unknown) => { if (!cancelled) { setStatus('error'); setError((e as Error).message); } });
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [cfg]);

  return (
    <Modal open={!!cfg} onClose={onClose} title="Connect Microsoft 365 inbox">
      <div className="space-y-4 text-sm">
        <p className="text-ink-muted">
          Microsoft requires a one-time sign-in to allow inbox reading (passwords alone no longer work for IMAP).
          Sign in as <strong>{cfg?.username}</strong>:
        </p>
        {status === 'starting' && <Skeleton className="h-16" />}
        {code && status !== 'done' && (
          <div className="rounded-md border border-line bg-surface-raised px-4 py-3 space-y-2">
            <p>1. Open <a className="underline" href={code.verificationUri} target="_blank" rel="noreferrer">{code.verificationUri}</a></p>
            <p>2. Enter this code:</p>
            <p className="text-2xl font-mono font-bold tracking-widest text-center select-all">{code.userCode}</p>
            <p className="text-xs text-ink-muted">3. Sign in with the mailbox's normal username and password. This page detects it automatically.</p>
          </div>
        )}
        {status === 'waiting' && <p className="text-ink-muted">Waiting for you to finish signing in…</p>}
        {status === 'done' && <p className="font-medium">✅ Connected. Replies are now syncing.</p>}
        {status === 'error' && <p className="text-red-600">Failed: {error}</p>}
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>{status === 'done' ? 'Close' : 'Cancel'}</Button>
        </div>
      </div>
    </Modal>
  );
}

function ImapTestBtn({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return <Button variant="ghost" disabled={busy} onClick={async () => {
    setBusy(true);
    try {
      await api(`/api/imap-configs/${id}/test`, { method: 'POST', body: JSON.stringify({}) });
      toast.success('Connected — INBOX is reachable.');
    }
    catch (e: unknown) { toast.error('Failed: ' + (e as Error).message); }
    finally { setBusy(false); }
  }}>Test</Button>;
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
