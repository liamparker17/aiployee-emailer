import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@aiployee/ui';
import { useAuth } from '@aiployee/ui';
import { useWizardState } from './state';
import { Input } from '@aiployee/ui';
import { Button } from '@aiployee/ui';
import { useToast } from '@aiployee/ui';

type SendStatus = 'idle' | 'sending' | 'sent' | 'failed';

type ErrDetails = {
  smtpCode?: number;
  smtpResponse?: string;
  command?: string;
  hint?: string;
};

type ErrState = {
  message: string;
  code?: string;
  details?: ErrDetails;
};

export function StepTest() {
  const [state, update] = useWizardState();
  const { user } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [to, setTo] = useState(user?.email ?? '');
  const [status, setStatus] = useState<SendStatus>('idle');
  const [err, setErr] = useState<ErrState | null>(null);

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
      toast.success('Test email sent successfully.');
      if (state.tenantId && localStorage.getItem('incompleteTenantId') === state.tenantId) {
        localStorage.removeItem('incompleteTenantId');
      }
    } catch (e: unknown) {
      const thrown = e as { code?: string; message?: string; details?: ErrDetails };
      const msg = thrown.message ?? 'Send failed.';
      setErr({
        message: msg,
        code: thrown.code,
        details: thrown.details,
      });
      setStatus('failed');
      toast.error(msg);
    }
  }

  if (status === 'sent') {
    return (
      <div className="bg-surface-raised border border-line-strong rounded-2xl p-6">
        <div className="space-y-5 max-w-md">
          <h2 className="text-xl font-heading font-semibold text-ink">All set</h2>
          <p className="text-sm text-ink-muted">
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
      </div>
    );
  }

  return (
    <div className="bg-surface-raised border border-line-strong rounded-2xl p-6">
      <form onSubmit={send} className="space-y-5 max-w-md">
        <h2 className="text-xl font-heading font-semibold text-ink">Send a test email</h2>
        <div>
          <label className="block text-sm mb-1 text-ink-muted">Send test to</label>
          <Input type="email" value={to} onChange={e => setTo(e.target.value)} required />
          <p className="text-xs text-ink-dim mt-1">Defaults to your email.</p>
        </div>

        {status === 'sending' && <div className="text-sm text-ink-dim">Sending…</div>}
        {status === 'failed' && err && (
          <div className="text-sm space-y-2">
            <div className="text-error font-semibold">{err.message}</div>
            {err.details?.smtpCode !== undefined && (
              <div className="font-mono text-xs text-ink-dim break-all">
                SMTP response: {err.details.smtpCode}
                {err.details.smtpResponse ? ` ${err.details.smtpResponse}` : ''}
              </div>
            )}
            {err.details?.command && (
              <div className="text-xs text-ink-dim">
                Failed at: <span className="font-mono">{err.details.command}</span>
              </div>
            )}
            {err.details?.hint && (
              <div className="text-xs bg-magenta/15 border border-magenta/30 text-ink-muted rounded px-3 py-2">
                {err.details.hint}
              </div>
            )}
            <button
              type="button"
              onClick={() => update({ step: '2' })}
              className="underline hover:no-underline text-error"
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
    </div>
  );
}
