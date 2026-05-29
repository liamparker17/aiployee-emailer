import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Button } from '../components/Button';
import { Input, Field } from '../components/Input';
import { Logo } from '../components/Logo';

export default function AcceptInvite() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [pw, setPw] = useState(''); const [err, setErr] = useState('');
  const nav = useNavigate();
  return (
    <div className="min-h-screen grid place-items-center p-4 bg-surface">
      <form className="bg-surface-raised border border-line-strong p-8 rounded-2xl w-[380px] shadow-glow space-y-4"
            onSubmit={async e => {
              e.preventDefault(); setErr('');
              try { await api('/auth/invite/accept', { method: 'POST', body: JSON.stringify({ token, password: pw }) }); nav('/login'); }
              catch (x: unknown) { setErr((x as Error).message); }
            }}>
        <div className="flex items-center gap-2 mb-2">
          <Logo size={36} />
          <span className="font-heading font-semibold text-xl text-ink">Aiployee</span>
        </div>
        <h1 className="text-xl font-heading font-semibold text-ink">Set your password</h1>
        <Field label="New password"><Input type="password" required minLength={8} value={pw} onChange={e => setPw(e.target.value)} /></Field>
        {err && <div className="text-sm text-error">{err}</div>}
        <Button type="submit">Continue</Button>
      </form>
    </div>
  );
}
