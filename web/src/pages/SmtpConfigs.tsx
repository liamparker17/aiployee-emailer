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

interface Cfg { id: string; name: string; host: string; port: number; secure: boolean; username: string; from_domain: string; is_default: boolean; auth_type?: 'password' | 'xoauth2' }

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
          <thead><tr><Th>Name</Th><Th>Username</Th><Th>Host</Th><Th>Port</Th><Th>From domain</Th><Th>Auth</Th><Th>{''}</Th></tr></thead>
          <tbody>{items.map(c => (
            <tr key={c.id}>
              <Td>{c.name}</Td><Td>{c.username}</Td><Td>{c.host}</Td><Td>{c.port}</Td><Td>{c.from_domain}</Td>
              <Td>
                {c.auth_type === 'xoauth2'
                  ? <span className="inline-flex items-center rounded-full bg-surface-raised px-2 py-0.5 text-xs font-medium text-ink">M365 OAuth</span>
                  : <span className="inline-flex items-center rounded-full bg-surface-raised px-2 py-0.5 text-xs font-medium text-ink-muted">Password</span>}
              </Td>
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
      <AddModal open={open} onClose={() => { setOpen(false); refresh(); }} onDone={refresh} />
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

// ---------------------------------------------------------------------------
// Microsoft 365 OAuth device-code flow (mirrors the inbound IMAP flow in
// Senders.tsx but points at the SMTP OAuth endpoints).
// ---------------------------------------------------------------------------

type FlowStatus = 'idle' | 'starting' | 'waiting' | 'done' | 'error';
interface SmtpDeviceCodeFlow {
  code: { userCode: string; verificationUri: string } | null;
  status: FlowStatus;
  error: string;
}

interface SmtpOAuthStartBody {
  username: string;
  name: string;
  fromDomain: string;
}

function useSmtpDeviceCodeFlow(
  startBody: SmtpOAuthStartBody | null,
  onDone: () => void,
): SmtpDeviceCodeFlow {
  const [code, setCode] = useState<SmtpDeviceCodeFlow['code']>(null);
  const [status, setStatus] = useState<FlowStatus>('idle');
  const [error, setError] = useState('');
  const toast = useToast();

  useEffect(() => {
    if (!startBody) { setCode(null); setStatus('idle'); setError(''); return; }
    setCode(null); setStatus('starting'); setError('');
    let cancelled = false;
    let timer: number | undefined;

    interface StartRes {
      username: string;
      userCode: string;
      verificationUri: string;
      deviceCode: string;
      intervalSeconds: number;
    }

    api<StartRes>('/api/smtp-configs/oauth/start', {
      method: 'POST',
      body: JSON.stringify({ username: startBody.username }),
    })
      .then(r => {
        if (cancelled) return;
        setCode({ userCode: r.userCode, verificationUri: r.verificationUri });
        setStatus('waiting');

        const poll = async () => {
          if (cancelled) return;
          try {
            const result = await api<{ pending?: boolean; config?: unknown }>(
              '/api/smtp-configs/oauth/complete',
              {
                method: 'POST',
                body: JSON.stringify({
                  deviceCode: r.deviceCode,
                  username: r.username,
                  name: startBody.name,
                  fromDomain: startBody.fromDomain,
                  host: 'smtp.office365.com',
                  port: 587,
                  secure: false,
                  isDefault: false,
                }),
              },
            );
            if (cancelled) return;
            if (result.pending) {
              timer = window.setTimeout(poll, Math.max(2, r.intervalSeconds) * 1000);
              return;
            }
            setStatus('done');
            toast.success('Microsoft 365 connected — you can now send from this address.');
            onDone();
          } catch (e: unknown) {
            if (cancelled) return;
            setStatus('error');
            setError((e as Error).message);
          }
        };

        timer = window.setTimeout(poll, Math.max(2, r.intervalSeconds) * 1000);
      })
      .catch((e: unknown) => {
        if (!cancelled) { setStatus('error'); setError((e as Error).message); }
      });

    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startBody]);

  return { code, status, error };
}

function SmtpDeviceCodePanel({ flow }: { flow: SmtpDeviceCodeFlow }) {
  return (
    <>
      {flow.status === 'starting' && <Skeleton className="h-16" />}
      {flow.code && flow.status !== 'done' && (
        <div className="rounded-md border border-line bg-surface-raised px-4 py-3 space-y-2 text-sm">
          <p>1. Open <a className="underline" href={flow.code.verificationUri} target="_blank" rel="noreferrer">{flow.code.verificationUri}</a></p>
          <p>2. Enter this code:</p>
          <p className="text-2xl font-mono font-bold tracking-widest text-center select-all">{flow.code.userCode}</p>
          <p className="text-xs text-ink-muted">3. Sign in with the M365 mailbox and approve the requested permission — this grants sending for this address. The page detects it automatically.</p>
        </div>
      )}
      {flow.status === 'waiting' && <p className="text-ink-muted text-sm">Waiting for you to finish signing in…</p>}
      {flow.status === 'done' && <p className="font-medium text-sm">✅ Connected. You can now send from this address.</p>}
      {flow.status === 'error' && <p className="text-sm text-red-600">Failed: {flow.error}</p>}
    </>
  );
}

// ---------------------------------------------------------------------------
// Add modal — toggles between M365 OAuth and Password (SMTP)
// ---------------------------------------------------------------------------

function AddModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [method, setMethod] = useState<'m365' | 'password'>('m365');
  const [m365Form, setM365Form] = useState({ name: '', email: '', fromDomain: '' });
  const [oauthBody, setOauthBody] = useState<SmtpOAuthStartBody | null>(null);

  const [form, setForm] = useState({ name: '', host: '', port: 587, secure: false, username: '', password: '', fromDomain: '', isDefault: false });
  const toast = useToast();

  const handleDone = () => { onDone(); onClose(); };
  const flow = useSmtpDeviceCodeFlow(oauthBody, handleDone);

  // Reset on open/close
  useEffect(() => {
    if (!open) return;
    setMethod('m365');
    setM365Form({ name: '', email: '', fromDomain: '' });
    setOauthBody(null);
    setForm({ name: '', host: '', port: 587, secure: false, username: '', password: '', fromDomain: '', isDefault: false });
  }, [open]);

  const flowInProgress = oauthBody !== null && flow.status !== 'done' && flow.status !== 'error';
  const m365CanStart = m365Form.name.trim() !== '' && m365Form.email.trim() !== '' && m365Form.fromDomain.trim() !== '';

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
      <div className="space-y-4">
        {/* Method toggle */}
        <Field label="Connection type">
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                checked={method === 'm365'}
                disabled={flowInProgress}
                onChange={() => { setMethod('m365'); setOauthBody(null); }}
              />
              Microsoft 365 (OAuth)
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                checked={method === 'password'}
                disabled={flowInProgress}
                onChange={() => setMethod('password')}
              />
              Password (SMTP)
            </label>
          </div>
        </Field>

        {/* ---- Microsoft 365 path ---- */}
        {method === 'm365' && (
          <form
            className="space-y-3"
            onSubmit={e => {
              e.preventDefault();
              if (!m365CanStart || flowInProgress) return;
              setOauthBody({ username: m365Form.email.trim(), name: m365Form.name.trim(), fromDomain: m365Form.fromDomain.trim() });
            }}
          >
            <Field label="Name" hint="e.g. Sales mailbox">
              <Input
                required
                value={m365Form.name}
                disabled={flowInProgress}
                onChange={e => setM365Form({ ...m365Form, name: e.target.value })}
              />
            </Field>
            <Field label="Email address" hint="The M365 mailbox you want to send from">
              <Input
                required
                type="email"
                value={m365Form.email}
                disabled={flowInProgress}
                onChange={e => setM365Form({ ...m365Form, email: e.target.value })}
              />
            </Field>
            <Field label="From domain" hint="e.g. company.co.za">
              <Input
                required
                value={m365Form.fromDomain}
                disabled={flowInProgress}
                onChange={e => setM365Form({ ...m365Form, fromDomain: e.target.value })}
              />
            </Field>

            {oauthBody && <SmtpDeviceCodePanel flow={flow} />}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" type="button" onClick={onClose}>
                {flow.status === 'done' ? 'Close' : 'Cancel'}
              </Button>
              {flow.status !== 'done' && (
                <Button
                  type="submit"
                  disabled={!m365CanStart || flowInProgress}
                >
                  {flow.status === 'error' ? 'Retry' : flowInProgress ? 'Connecting…' : 'Connect Microsoft 365'}
                </Button>
              )}
            </div>
          </form>
        )}

        {/* ---- Password / SMTP path ---- */}
        {method === 'password' && (
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
        )}
      </div>
    </Modal>
  );
}
