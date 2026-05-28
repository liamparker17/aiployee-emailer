import { useState } from 'react';
import { api } from '../../api';
import { useWizardState } from './state';
import { Input } from '../../components/Input';
import { Button } from '../../components/Button';

interface Preset { label: string; host: string; port: number; secure: boolean }
const PRESETS: Record<string, Preset> = {
  gmail:   { label: 'Gmail',   host: 'smtp.gmail.com',     port: 465, secure: true  },
  outlook: { label: 'Outlook', host: 'smtp.office365.com', port: 587, secure: false },
  custom:  { label: 'Custom',  host: '',                   port: 587, secure: false },
};

export function StepSender() {
  const [state, update] = useWizardState();
  const [preset, setPreset] = useState<keyof typeof PRESETS>('gmail');
  const [host, setHost] = useState(PRESETS.gmail.host);
  const [port, setPort] = useState<number>(PRESETS.gmail.port);
  const [secure, setSecure] = useState(PRESETS.gmail.secure);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fromName, setFromName] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function selectPreset(key: keyof typeof PRESETS) {
    setPreset(key);
    const p = PRESETS[key];
    setHost(p.host); setPort(p.port); setSecure(p.secure);
  }

  const fromDomain = fromEmail.split('@')[1] ?? '';

  async function onNext(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setSubmitting(true);
    try {
      // 1) create SMTP config (active tenant is set in session)
      const smtp = await api<{ config: { id: string; from_domain: string } }>(
        '/api/smtp-configs',
        {
          method: 'POST',
          body: JSON.stringify({
            name: `${state.tenantName ?? 'Tenant'} default`,
            host, port, secure,
            username, password,
            fromDomain,
            isDefault: true,
          }),
        },
      );
      // 2) create sender
      const sender = await api<{ sender: { id: string; email: string } }>(
        '/api/senders',
        {
          method: 'POST',
          body: JSON.stringify({
            email: fromEmail,
            displayName: fromName,
            smtpConfigId: smtp.config.id,
            isDefault: true,
          }),
        },
      );
      update({
        step: '3',
        smtpConfigId: smtp.config.id,
        senderId: sender.sender.id,
        senderEmail: sender.sender.email,
        fromDomain,
      });
    } catch (e: unknown) {
      setErr((e as Error)?.message ?? 'Failed to create sender.');
    } finally { setSubmitting(false); }
  }

  return (
    <form onSubmit={onNext} className="space-y-5 max-w-md">
      <h2 className="text-xl font-heading font-semibold">Add a sender</h2>

      <div>
        <label className="block text-sm mb-1">From name</label>
        <Input value={fromName} onChange={e => setFromName(e.target.value)} required />
      </div>
      <div>
        <label className="block text-sm mb-1">From email</label>
        <Input type="email" value={fromEmail} onChange={e => setFromEmail(e.target.value)} required />
      </div>

      <div>
        <div className="text-sm mb-2">SMTP provider</div>
        <div className="flex gap-2">
          {(Object.keys(PRESETS) as Array<keyof typeof PRESETS>).map(k => (
            <button type="button" key={k} onClick={() => selectPreset(k)}
              className={`px-3 py-1.5 text-sm rounded-md border ${
                preset === k ? 'bg-ink text-white border-ink' : 'border-line text-muted hover:text-ink'
              }`}>{PRESETS[k].label}</button>
          ))}
        </div>
      </div>

      {preset === 'custom' && (
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="block text-sm mb-1">Host</label>
            <Input value={host} onChange={e => setHost(e.target.value)} required />
          </div>
          <div>
            <label className="block text-sm mb-1">Port</label>
            <Input type="number" value={port} onChange={e => setPort(Number(e.target.value))} required />
          </div>
          <div className="flex items-end">
            <label className="text-sm flex items-center gap-2">
              <input type="checkbox" checked={secure} onChange={e => setSecure(e.target.checked)} />
              Use TLS
            </label>
          </div>
        </div>
      )}

      <div>
        <label className="block text-sm mb-1">SMTP username</label>
        <Input value={username} onChange={e => setUsername(e.target.value)} required />
      </div>
      <div>
        <label className="block text-sm mb-1">SMTP password</label>
        <Input type="password" value={password} onChange={e => setPassword(e.target.value)} required />
      </div>

      {err && <div className="text-sm text-red-600">{err}</div>}
      <div className="flex gap-3">
        <Button type="button" variant="ghost" onClick={() => update({ step: '1' })}>Back</Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Next'}
        </Button>
      </div>
    </form>
  );
}
