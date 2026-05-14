import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Button } from '../components/Button';
import { Input, Field } from '../components/Input';

export default function AcceptInvite() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [pw, setPw] = useState(''); const [err, setErr] = useState('');
  const nav = useNavigate();
  return (
    <div className="min-h-screen grid place-items-center bg-surface">
      <form className="bg-bg p-8 rounded-lg w-[380px] shadow border border-line space-y-4"
            onSubmit={async e => {
              e.preventDefault(); setErr('');
              try { await api('/auth/invite/accept', { method: 'POST', body: JSON.stringify({ token, password: pw }) }); nav('/login'); }
              catch (x: unknown) { setErr((x as Error).message); }
            }}>
        <h1 className="text-xl font-heading font-semibold">Set your password</h1>
        <Field label="New password"><Input type="password" required minLength={8} value={pw} onChange={e => setPw(e.target.value)} /></Field>
        {err && <div className="text-sm text-red-600">{err}</div>}
        <Button type="submit">Continue</Button>
      </form>
    </div>
  );
}
