import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Send, Inbox } from 'lucide-react';
import { api } from '@aiployee/ui';
import { Table, Th, Td } from '@aiployee/ui';
import { Button } from '@aiployee/ui';
import { Modal } from '@aiployee/ui';
import { Input, Field } from '@aiployee/ui';
import { PageHeader } from '@aiployee/ui';
import { EmptyState } from '@aiployee/ui';
import { Skeleton } from '@aiployee/ui';
import { useToast } from '@aiployee/ui';

interface Sender { id: string; email: string; display_name: string; reply_to: string | null; smtp_config_id: string; is_default: boolean }
interface Cfg { id: string; name: string; from_domain: string }
interface ImapCfg { id: string; sender_id: string | null; host: string; username: string; enabled: boolean; last_error: string | null; auth_type: 'password' | 'xoauth2' }

export default function Senders() {
  const [items, setItems] = useState<Sender[]>([]);
  const [configs, setConfigs] = useState<Cfg[]>([]);
  const [imapItems, setImapItems] = useState<ImapCfg[]>([]);
  const [open, setOpen] = useState(false);
  const [connectFor, setConnectFor] = useState<{ email: string; senderId: string | null } | null>(null);
  const [graphSendOpen, setGraphSendOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const toast = useToast();
  const refresh = () => Promise.all([
    api<{ senders: Sender[] }>('/api/senders').then(r => setItems(r.senders)),
    api<{ configs: Cfg[] }>('/api/smtp-configs').then(r => setConfigs(r.configs)),
    api<{ configs: ImapCfg[] }>('/api/imap-configs').then(r => setImapItems(r.configs)),
  ]).then(() => setLoading(false));
  useEffect(() => { refresh(); }, []);

  // A sender counts as monitored when an IMAP config is linked to it, or one
  // watches the same address (legacy rows created before sender linking).
  const isMonitored = (s: Sender) =>
    imapItems.some(c => c.sender_id === s.id || c.username.toLowerCase() === s.email.toLowerCase());

  return (
    <div className="space-y-6">
      <PageHeader
        title="Senders"
        subtitle="Verified sender addresses used to send emails."
        actions={
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setGraphSendOpen(true)}>Enable M365 sending (Graph)</Button>
            <Button onClick={() => setOpen(true)}>Add sender</Button>
          </div>
        }
      />
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={Send} title="No senders yet" description="Add a verified sender to start sending." />
      ) : (
        <Table>
          <thead><tr><Th>Email</Th><Th>Display name</Th><Th>Reply-to</Th><Th>SMTP</Th><Th>{''}</Th></tr></thead>
          <tbody>{items.map(s => (
            <tr key={s.id}>
              <Td>{s.email}</Td><Td>{s.display_name}</Td><Td>{s.reply_to ?? '—'}</Td>
              <Td>{configs.find(c => c.id === s.smtp_config_id)?.name ?? s.smtp_config_id.slice(0,8)}</Td>
              <Td><div className="flex gap-2 justify-end">
              {isMonitored(s) ? (
                <Button variant="ghost" disabled>Monitored</Button>
              ) : (
                <Button variant="ghost" onClick={() => setConnectFor({ email: s.email, senderId: s.id })}>Monitor inbox</Button>
              )}
              <Button variant="danger" onClick={async () => {
                if (!confirm(`Delete ${s.email}?`)) return;
                try {
                  await api(`/api/senders/${s.id}`, { method: 'DELETE' });
                  toast.success('Deleted');
                  refresh();
                } catch (e) {
                  toast.error((e as Error).message);
                }
              }}>Delete</Button></div></Td>
            </tr>
          ))}</tbody>
        </Table>
      )}

      <div className="space-y-3 pt-4">
        <PageHeader
          title="Inbox monitoring"
          subtitle="Sender mailboxes read over IMAP so campaign replies flow into the system for Abe to analyze."
          actions={<Button onClick={() => setConnectFor({ email: '', senderId: null })}>Connect mailbox</Button>}
        />
        {!loading && imapItems.length === 0 ? (
          <EmptyState icon={Inbox} title="No monitored inboxes" description="Use “Monitor inbox” on a sender to start syncing its replies." />
        ) : (
          <Table>
            <thead><tr><Th>Mailbox</Th><Th>Sender</Th><Th>Status</Th><Th>{''}</Th></tr></thead>
            <tbody>{imapItems.map(c => (
              <tr key={c.id}>
                <Td>{c.username}{c.auth_type === 'xoauth2' ? ' (Microsoft sign-in)' : ''}</Td>
                <Td>{items.find(s => s.id === c.sender_id)?.display_name ?? '—'}</Td>
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

      <AddModal open={open} onClose={() => { setOpen(false); refresh(); }} configs={configs} />
      <ConnectMailboxModal target={connectFor} onClose={() => { setConnectFor(null); refresh(); }} />
      <GraphSendModal open={graphSendOpen} onClose={() => { setGraphSendOpen(false); refresh(); }} />
    </div>
  );
}

type FlowStatus = 'idle' | 'starting' | 'waiting' | 'done' | 'error';
interface DeviceCodeFlow { code: { userCode: string; verificationUri: string } | null; status: FlowStatus; error: string }

// Drives the Microsoft device-code dance: start → show code → poll complete until
// the sign-in lands. Pass null to stay idle; completeExtra is merged into the
// complete call (e.g. the senderId to link the mailbox to).
function useDeviceCodeFlow(startBody: Record<string, unknown> | null, completeExtra?: Record<string, unknown>): DeviceCodeFlow {
  const [code, setCode] = useState<DeviceCodeFlow['code']>(null);
  const [status, setStatus] = useState<FlowStatus>('idle');
  const [error, setError] = useState('');
  const toast = useToast();

  useEffect(() => {
    if (!startBody) { setCode(null); setStatus('idle'); setError(''); return; }
    setCode(null); setStatus('starting'); setError('');
    let cancelled = false;
    let timer: number | undefined;
    interface StartRes { username: string; userCode: string; verificationUri: string; deviceCode: string; intervalSeconds: number }
    api<StartRes>('/api/imap-configs/oauth/start', { method: 'POST', body: JSON.stringify(startBody) })
      .then(r => {
        if (cancelled) return;
        setCode({ userCode: r.userCode, verificationUri: r.verificationUri });
        setStatus('waiting');
        const poll = async () => {
          if (cancelled) return;
          try {
            const c = await api<{ pending?: boolean }>('/api/imap-configs/oauth/complete', {
              method: 'POST',
              body: JSON.stringify({ deviceCode: r.deviceCode, username: r.username, ...completeExtra }),
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startBody]);

  return { code, status, error };
}

function DeviceCodePanel({ flow }: { flow: DeviceCodeFlow }) {
  return (
    <>
      {flow.status === 'starting' && <Skeleton className="h-16" />}
      {flow.code && flow.status !== 'done' && (
        <div className="rounded-md border border-line bg-surface-raised px-4 py-3 space-y-2">
          <p>1. Open <a className="underline" href={flow.code.verificationUri} target="_blank" rel="noreferrer">{flow.code.verificationUri}</a></p>
          <p>2. Enter this code:</p>
          <p className="text-2xl font-mono font-bold tracking-widest text-center select-all">{flow.code.userCode}</p>
          <p className="text-xs text-ink-muted">3. Sign in with the mailbox's normal username and password. This page detects it automatically.</p>
        </div>
      )}
      {flow.status === 'waiting' && <p className="text-ink-muted">Waiting for you to finish signing in…</p>}
      {flow.status === 'done' && <p className="font-medium">✅ Connected. Replies are now syncing.</p>}
      {flow.status === 'error' && <p className="text-red-600">Failed: {flow.error}</p>}
    </>
  );
}

// Connect a sender's mailbox.
//
// Two paths depending on whether we already have a sender to attach to:
//   • standalone (senderId === null): M365 runs the FULL unified flow
//     (/api/m365/connect/*) — creates sender + SMTP + inbox in one sign-in.
//     Password/IMAP path still available for non-M365 mailboxes.
//   • attach (senderId is set): the sender already sends; we only wire inbox
//     monitoring. M365 uses /api/imap-configs/oauth/* (imap-only). Unchanged.
function ConnectMailboxModal({ target, onClose }: { target: { email: string; senderId: string | null } | null; onClose: () => void }) {
  const open = target !== null;
  // Is this a standalone "new mailbox" flow (no existing sender)?
  const isStandalone = target?.senderId === null || target?.senderId === undefined;

  const [email, setEmail] = useState('');
  const [method, setMethod] = useState<'m365' | 'password'>('m365');
  const [manual, setManual] = useState({ host: '', port: 993, secure: true, password: '' });
  const toast = useToast();

  // ── State for standalone M365 unified flow ──
  const [displayName, setDisplayName] = useState('');
  const [fromDomain, setFromDomain] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [unifiedStartBody, setUnifiedStartBody] = useState<Record<string, unknown> | null>(null);
  const unifiedCompleteExtra = useMemo(() => ({
    name: displayName.trim() || `${email.trim()} (M365)`,
    fromDomain: fromDomain.trim(),
    displayName: displayName.trim(),
    isDefault,
  }), [displayName, email, fromDomain, isDefault]);
  // Auto-fill fromDomain from email
  useEffect(() => {
    const domain = email.split('@')[1] ?? '';
    if (domain) setFromDomain(d => d || domain);
  }, [email]);

  // ── State for attach / imap-only flow ──
  const [oauthBody, setOauthBody] = useState<Record<string, unknown> | null>(null);
  const imapCompleteExtra = useMemo(
    () => ({ senderId: target?.senderId ?? null }),
    [target?.senderId], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Both hooks are always called (rules of hooks). Only the active path gets a non-null startBody.
  const unifiedFlow = useM365ConnectFlow(
    isStandalone && method === 'm365' ? unifiedStartBody : null,
    unifiedCompleteExtra,
    onClose,
  );
  const imapFlow = useDeviceCodeFlow(
    !isStandalone && method === 'm365' ? oauthBody : null,
    imapCompleteExtra,
  );

  useEffect(() => {
    if (open) {
      setEmail(target?.email ?? '');
      setMethod('m365');
      setUnifiedStartBody(null);
      setOauthBody(null);
      setDisplayName('');
      setFromDomain('');
      setIsDefault(false);
      setManual({ host: '', port: 993, secure: true, password: '' });
    }
  }, [open, target]);

  const unifiedStarted = unifiedStartBody !== null;
  const imapStarted = oauthBody !== null;
  const started = isStandalone ? unifiedStarted : imapStarted;
  const activeFlow = isStandalone ? unifiedFlow : imapFlow;

  const canStartUnified = isStandalone && email.trim() !== '' && displayName.trim() !== '' && fromDomain.trim() !== '' && !unifiedStarted;

  return (
    <Modal open={open} onClose={onClose} title="Connect a mailbox">
      <form className="space-y-3 text-sm" onSubmit={async e => {
        e.preventDefault();
        if (method === 'm365') {
          if (isStandalone) {
            setUnifiedStartBody({ username: email.trim() });
          } else {
            setOauthBody({ username: email.trim() });
          }
          return;
        }
        // Password / IMAP path — always imap-only
        try {
          await api('/api/imap-configs', {
            method: 'POST',
            body: JSON.stringify({
              host: manual.host, port: manual.port, secure: manual.secure,
              username: email.trim(), password: manual.password, senderId: target?.senderId ?? null,
            }),
          });
          toast.success('Inbox monitoring enabled — replies will sync every few minutes.');
          onClose();
        } catch (err: unknown) {
          toast.error('Connect failed: ' + (err as Error).message);
        }
      }}>
        {isStandalone && method === 'm365' ? (
          <p className="text-ink-muted">
            One sign-in connects this mailbox for <strong>sending</strong> AND <strong>reply sync</strong> — no app passwords needed.
          </p>
        ) : (
          <p className="text-ink-muted">Replies to your campaigns land in this mailbox — connect it so they flow into the system.</p>
        )}
        <Field label="Mailbox address"><Input required type="email" value={email} disabled={started} onChange={e => setEmail(e.target.value)} /></Field>
        <Field label="How does this mailbox authenticate?">
          <div className="flex gap-4">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={method === 'm365'} disabled={started} onChange={() => setMethod('m365')} />
              Microsoft 365 / Outlook (sign in)
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={method === 'password'} disabled={started} onChange={() => setMethod('password')} />
              IMAP password
            </label>
          </div>
        </Field>

        {/* Standalone M365: collect display name + from domain for full sender setup */}
        {isStandalone && method === 'm365' && (
          <>
            <Field label="Display name" hint="The 'From' name shown in recipients' inboxes">
              <Input required placeholder="Acme Sales" value={displayName} disabled={unifiedStarted} onChange={e => setDisplayName(e.target.value)} />
            </Field>
            <Field label="From domain" hint="Domain portion of the sending address (auto-filled from email)">
              <Input required placeholder="yourcompany.com" value={fromDomain} disabled={unifiedStarted} onChange={e => setFromDomain(e.target.value)} />
            </Field>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={isDefault} disabled={unifiedStarted} onChange={e => setIsDefault(e.target.checked)} />
              <span>Set as default sender</span>
            </label>
          </>
        )}

        {method === 'password' && (
          <>
            <Field label="IMAP host" hint="e.g. imap.gmail.com — for Gmail use an app password"><Input required value={manual.host} onChange={e => setManual({ ...manual, host: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Port"><Input type="number" required value={manual.port} onChange={e => setManual({ ...manual, port: Number(e.target.value) })} /></Field>
              <Field label="Secure (TLS)"><input type="checkbox" checked={manual.secure} onChange={e => setManual({ ...manual, secure: e.target.checked })} /></Field>
            </div>
            <Field label="Password"><Input required type="password" value={manual.password} onChange={e => setManual({ ...manual, password: e.target.value })} /></Field>
          </>
        )}

        {method === 'm365' && started && (
          isStandalone ? <M365DeviceCodePanel flow={unifiedFlow} /> : <DeviceCodePanel flow={imapFlow} />
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" type="button" onClick={onClose}>{activeFlow.status === 'done' ? 'Close' : 'Cancel'}</Button>
          {!(method === 'm365' && started) && (
            <Button type="submit" disabled={isStandalone && method === 'm365' ? !canStartUnified : false}>
              {method === 'm365' ? 'Start sign-in' : 'Connect'}
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Microsoft 365 unified connect (sync + send in one device-code flow)
// ──────────────────────────────────────────────────────────────────────────────

interface M365StartRes {
  username: string;
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

interface M365FlowState {
  code: { userCode: string; verificationUri: string } | null;
  status: FlowStatus;
  error: string;
}

// Like useDeviceCodeFlow but wired to /api/m365/connect/start + /api/m365/connect/complete.
// completeExtra carries name, fromDomain, displayName, isDefault.
function useM365ConnectFlow(
  startBody: Record<string, unknown> | null,
  completeExtra: Record<string, unknown>,
  onDone: () => void,
): M365FlowState {
  const [code, setCode] = useState<M365FlowState['code']>(null);
  const [status, setStatus] = useState<FlowStatus>('idle');
  const [error, setError] = useState('');
  const toast = useToast();

  useEffect(() => {
    if (!startBody) { setCode(null); setStatus('idle'); setError(''); return; }
    setCode(null); setStatus('starting'); setError('');
    let cancelled = false;
    let timer: number | undefined;
    api<M365StartRes>('/api/m365/connect/start', { method: 'POST', body: JSON.stringify(startBody) })
      .then(r => {
        if (cancelled) return;
        setCode({ userCode: r.userCode, verificationUri: r.verificationUri });
        setStatus('waiting');
        const poll = async () => {
          if (cancelled) return;
          try {
            const c = await api<{ pending?: boolean }>('/api/m365/connect/complete', {
              method: 'POST',
              body: JSON.stringify({ deviceCode: r.deviceCode, username: r.username, ...completeExtra }),
            });
            if (cancelled) return;
            if (c.pending) {
              timer = window.setTimeout(poll, Math.max(2, r.intervalSeconds) * 1000);
              return;
            }
            setStatus('done');
            toast.success('Microsoft 365 connected — this address can now sync replies AND send.');
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

function M365DeviceCodePanel({ flow }: { flow: M365FlowState }) {
  return (
    <>
      {flow.status === 'starting' && <Skeleton className="h-16" />}
      {flow.code && flow.status !== 'done' && (
        <div className="rounded-md border border-line bg-surface-raised px-4 py-3 space-y-2">
          <p>1. Open{' '}<a className="underline" href={flow.code.verificationUri} target="_blank" rel="noreferrer">{flow.code.verificationUri}</a></p>
          <p>2. Enter this code:</p>
          <p className="text-2xl font-mono font-bold tracking-widest text-center select-all">{flow.code.userCode}</p>
          <p className="text-xs text-ink-muted">
            3. Sign in with the mailbox's Microsoft credentials. This approval grants both{' '}
            <strong>reading replies</strong> and <strong>sending emails</strong> for this mailbox.
          </p>
        </div>
      )}
      {flow.status === 'waiting' && <p className="text-ink-muted">Waiting for you to approve in the browser…</p>}
      {flow.status === 'done' && (
        <p className="font-medium text-green-700 dark:text-green-400">
          ✅ Connected — inbox sync and sending are both active.
        </p>
      )}
      {flow.status === 'error' && <p className="text-error text-sm">Failed: {flow.error}</p>}
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Microsoft Graph send device-code flow (sending only, works when SMTP blocked)
// ──────────────────────────────────────────────────────────────────────────────

// Like useM365ConnectFlow but wired to /api/m365/graph-send/start + /api/m365/graph-send/complete.
// completeExtra carries name, fromDomain, displayName, isDefault.
function useGraphSendFlow(
  startBody: Record<string, unknown> | null,
  completeExtra: Record<string, unknown>,
  onDone: () => void,
): M365FlowState {
  const [code, setCode] = useState<M365FlowState['code']>(null);
  const [status, setStatus] = useState<FlowStatus>('idle');
  const [error, setError] = useState('');
  const toast = useToast();

  useEffect(() => {
    if (!startBody) { setCode(null); setStatus('idle'); setError(''); return; }
    setCode(null); setStatus('starting'); setError('');
    let cancelled = false;
    let timer: number | undefined;
    api<M365StartRes>('/api/m365/graph-send/start', { method: 'POST', body: JSON.stringify(startBody) })
      .then(r => {
        if (cancelled) return;
        setCode({ userCode: r.userCode, verificationUri: r.verificationUri });
        setStatus('waiting');
        const poll = async () => {
          if (cancelled) return;
          try {
            const c = await api<{ pending?: boolean }>('/api/m365/graph-send/complete', {
              method: 'POST',
              body: JSON.stringify({ deviceCode: r.deviceCode, username: r.username, ...completeExtra }),
            });
            if (cancelled) return;
            if (c.pending) {
              timer = window.setTimeout(poll, Math.max(2, r.intervalSeconds) * 1000);
              return;
            }
            setStatus('done');
            toast.success('Microsoft 365 sending enabled (via Graph). Send a test to confirm.');
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

function GraphSendDeviceCodePanel({ flow }: { flow: M365FlowState }) {
  return (
    <>
      {flow.status === 'starting' && <Skeleton className="h-16" />}
      {flow.code && flow.status !== 'done' && (
        <div className="rounded-md border border-line bg-surface-raised px-4 py-3 space-y-2">
          <p>1. Open{' '}<a className="underline" href={flow.code.verificationUri} target="_blank" rel="noreferrer">{flow.code.verificationUri}</a></p>
          <p>2. Enter this code:</p>
          <p className="text-2xl font-mono font-bold tracking-widest text-center select-all">{flow.code.userCode}</p>
          <p className="text-xs text-ink-muted">
            3. Approve the code — this grants sending via Microsoft Graph (works even when SMTP is disabled on your tenant).
          </p>
        </div>
      )}
      {flow.status === 'waiting' && <p className="text-ink-muted">Waiting for you to approve in the browser…</p>}
      {flow.status === 'done' && (
        <p className="font-medium text-green-700 dark:text-green-400">
          ✅ Microsoft 365 sending enabled — send a test to confirm.
        </p>
      )}
      {flow.status === 'error' && <p className="text-error text-sm">Failed: {flow.error}</p>}
    </>
  );
}

function GraphSendModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [fromDomain, setFromDomain] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [startBody, setStartBody] = useState<Record<string, unknown> | null>(null);

  // Auto-fill fromDomain from email
  useEffect(() => {
    const domain = email.split('@')[1] ?? '';
    if (domain) setFromDomain(d => d || domain);
  }, [email]);

  const completeExtra = useMemo(() => ({
    name: displayName.trim(),
    fromDomain: fromDomain.trim(),
    displayName: displayName.trim(),
    isDefault,
  }), [displayName, fromDomain, isDefault]);

  // Always called per rules-of-hooks; pass null when modal is closed.
  const flow = useGraphSendFlow(open ? startBody : null, completeExtra, onClose);

  // Reset when modal opens/closes
  useEffect(() => {
    if (open) {
      setEmail('');
      setDisplayName('');
      setFromDomain('');
      setIsDefault(false);
      setStartBody(null);
    }
  }, [open]);

  const started = startBody !== null;
  const canConnect = email.trim() !== '' && displayName.trim() !== '' && fromDomain.trim() !== '' && !started && flow.status !== 'starting' && flow.status !== 'waiting';

  return (
    <Modal open={open} onClose={onClose} title="Enable M365 sending (Graph)">
      <form className="space-y-3 text-sm" onSubmit={e => {
        e.preventDefault();
        if (!canConnect) return;
        setStartBody({ username: email.trim() });
      }}>
        <p className="text-ink-muted">
          Approve a one-time device code to let this address send via Microsoft Graph —{' '}
          works even when SMTP is blocked on your tenant.
        </p>
        <Field label="Email address">
          <Input required type="email" value={email} disabled={started} onChange={e => setEmail(e.target.value)} />
        </Field>
        <Field label="Display name" hint="The 'From' name shown in recipients' inboxes">
          <Input required placeholder="Acme Sales" value={displayName} disabled={started} onChange={e => setDisplayName(e.target.value)} />
        </Field>
        <Field label="From domain" hint="Domain portion of the sending address (auto-filled from email)">
          <Input required placeholder="yourcompany.com" value={fromDomain} disabled={started} onChange={e => setFromDomain(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={isDefault} disabled={started} onChange={e => setIsDefault(e.target.checked)} />
          <span>Set as default sender</span>
        </label>

        {started && <GraphSendDeviceCodePanel flow={flow} />}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" type="button" onClick={onClose}>{flow.status === 'done' ? 'Close' : 'Cancel'}</Button>
          {!started && (
            <Button type="submit" disabled={!canConnect}>Connect</Button>
          )}
        </div>
      </form>
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

function AddModal({ open, onClose, configs }: { open: boolean; onClose: () => void; configs: Cfg[] }) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [mode, setMode] = useState<'existing' | 'new'>('new');
  const [smtpConfigId, setSmtpConfigId] = useState('');
  const [smtp, setSmtp] = useState({ host: '', port: 587, secure: false, username: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();

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
      toast.success('Saved');
      onClose();
    } catch (e) {
      setErr((e as Error).message || 'Something went wrong');
      toast.error((e as Error).message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const selectClass = 'w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink';

  return (
    <Modal open={open} onClose={onClose} title="Add sender">
      <form className="space-y-3" onSubmit={submit}>
        <Field label="Email"><Input required type="email" value={email} onChange={e => setEmail(e.target.value)} /></Field>
        <Field label="Display name"><Input required value={displayName} onChange={e => setDisplayName(e.target.value)} /></Field>
        <Field label="Reply-to (optional)"><Input type="email" value={replyTo} onChange={e => setReplyTo(e.target.value)} /></Field>

        <div className="border-t border-line pt-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-ink">Email connection (SMTP)</span>
            {configs.length > 0 && (
              <div className="flex gap-1 text-xs">
                <button type="button" onClick={() => setMode('existing')}
                  className={`px-2 py-1 rounded-btn ${mode === 'existing' ? 'bg-surface-raised text-ink font-medium' : 'text-ink-muted'}`}>Use existing</button>
                <button type="button" onClick={() => setMode('new')}
                  className={`px-2 py-1 rounded-btn ${mode === 'new' ? 'bg-surface-raised text-ink font-medium' : 'text-ink-muted'}`}>New connection</button>
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
                <span className="text-ink-muted">Quick fill:</span>
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

        {err && <p className="text-sm text-error">{err}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
        </div>
      </form>
    </Modal>
  );
}
