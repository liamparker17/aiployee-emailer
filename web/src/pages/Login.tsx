import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@aiployee/ui';
import { api } from '@aiployee/ui';
import { Button } from '@aiployee/ui';
import { Input, Field } from '@aiployee/ui';
import { Logo } from '@aiployee/ui';

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [err, setErr] = useState('');
  const [mode, setMode] = useState<'signin' | 'forgot'>('signin');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function requestReset(e: React.FormEvent) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      await api('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
      setSent(true);
    } catch (x: unknown) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center p-4 bg-surface">
      <form className="bg-surface-raised border border-line-strong p-8 rounded-2xl w-[380px] shadow-glow space-y-4"
            onSubmit={mode === 'signin'
              ? async e => { e.preventDefault(); setErr(''); try { await login(email, pw); nav('/'); } catch (x: unknown) { setErr((x as Error).message); } }
              : requestReset}>
        <div className="flex items-center gap-2 mb-2">
          <Logo size={36} />
          <span className="font-heading font-semibold text-xl text-ink">Aiployee</span>
        </div>

        {mode === 'signin' ? (
          <>
            <h1 className="text-xl font-heading font-semibold text-ink">Sign in to Aiployee Emailer</h1>
            <Field label="Email"><Input type="email" required value={email} onChange={e => setEmail(e.target.value)} /></Field>
            <Field label="Password"><Input type="password" required value={pw} onChange={e => setPw(e.target.value)} /></Field>
            {err && <div className="text-sm text-error">{err}</div>}
            <Button type="submit" variant="primary">Sign in</Button>
            <button type="button" className="text-sm text-ink-muted hover:text-ink underline"
                    onClick={() => { setMode('forgot'); setErr(''); }}>
              Forgot password?
            </button>
          </>
        ) : sent ? (
          <>
            <h1 className="text-xl font-heading font-semibold text-ink">Check your email</h1>
            <p className="text-sm text-ink-muted">
              If an account exists for {email}, we've sent a link to reset your password. It expires in an hour.
            </p>
            <button type="button" className="text-sm text-ink-muted hover:text-ink underline"
                    onClick={() => { setMode('signin'); setSent(false); }}>
              Back to sign in
            </button>
          </>
        ) : (
          <>
            <h1 className="text-xl font-heading font-semibold text-ink">Reset your password</h1>
            <p className="text-sm text-ink-muted">Enter your email and we'll send you a link to set a new password.</p>
            <Field label="Email"><Input type="email" required value={email} onChange={e => setEmail(e.target.value)} /></Field>
            {err && <div className="text-sm text-error">{err}</div>}
            <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</Button>
            <button type="button" className="text-sm text-ink-muted hover:text-ink underline"
                    onClick={() => { setMode('signin'); setErr(''); }}>
              Back to sign in
            </button>
          </>
        )}
      </form>
    </div>
  );
}
