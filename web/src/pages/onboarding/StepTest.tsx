import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { useWizardState } from './state';
import { Input } from '../../components/Input';
import { Button } from '../../components/Button';

type SendStatus = 'idle' | 'sending' | 'sent' | 'failed';

export function StepTest() {
  const [state, update] = useWizardState();
  const { user } = useAuth();
  const nav = useNavigate();
  const [to, setTo] = useState(user?.email ?? '');
  const [status, setStatus] = useState<SendStatus>('idle');
  const [err, setErr] = useState<string | null>(null);

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    if (!state.smtpConfigId) return;
    setStatus('sending');
    setErr(null);
    try {
      await api<{ ok: true; messageId: string }>(
        `/api/smtp-configs/${state.smtpConfigId}/test`,
        { method: 'POST', body: JSON.stringify({ to }) },
      );
      setStatus('sent');
      if (state.tenantId && localStorage.getItem('incompleteTenantId') === state.tenantId) {
        localStorage.removeItem('incompleteTenantId');
      }
    } catch (e: unknown) {
      const msg = (e as { body?: { error?: { message?: string } } }).body?.error?.message
        ?? (e as Error).message;
      setErr(msg ?? 'Send failed.');
      setStatus('failed');
    }
  }

  if (status === 'sent') {
    return (
      <div className="space-y-5 max-w-md">
        <h2 className="text-xl font-heading font-semibold">All set</h2>
        <p className="text-sm text-muted">
          Test email delivered to <span className="text-ink">{to}</span>. Check that inbox to confirm.
        </p>
        <div className="flex gap-3">
          <Button onClick={() => state.tenantId && nav(`/t/${state.tenantId}`)}>
            Go to tenant dashboard
          </Button>
          <Button type="button" variant="ghost" onClick={() => setStatus('idle')}>
            Send another test
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={send} className="space-y-5 max-w-md">
      <h2 className="text-xl font-heading font-semibold">Send a test email</h2>
      <div>
        <label className="block text-sm mb-1">Send test to</label>
        <Input type="email" value={to} onChange={e => setTo(e.target.value)} required />
        <p className="text-xs text-muted mt-1">Defaults to your email.</p>
      </div>

      {status === 'sending' && <div className="text-sm text-muted">Sending…</div>}
      {status === 'failed' && (
        <div className="text-sm text-red-600 space-y-2">
          <div>{err}</div>
          <button
            type="button"
            onClick={() => update({ step: '2' })}
            className="underline hover:no-underline"
          >
            Back to SMTP settings
          </button>
        </div>
      )}

      <div className="flex gap-3">
        <Button type="button" variant="ghost" onClick={() => update({ step: '2' })}>
          Back
        </Button>
        <Button type="submit" disabled={status === 'sending'}>
          {status === 'sending' ? 'Sending…' : 'Send test'}
        </Button>
      </div>
    </form>
  );
}
