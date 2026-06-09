import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { Button } from '../components/Button';
import { Input, Field } from '../components/Input';
import { Logo } from '../components/Logo';

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [err, setErr] = useState('');
  return (
    <div className="min-h-screen grid place-items-center p-4 bg-surface">
      <form className="bg-surface-raised border border-line-strong p-8 rounded-2xl w-[380px] shadow-glow space-y-4"
            onSubmit={async e => { e.preventDefault(); setErr(''); try { await login(email, pw); nav('/'); } catch (x: unknown) { setErr((x as Error).message); } }}>
        <div className="flex items-center gap-2 mb-2">
          <Logo size={36} />
          <span className="font-heading font-semibold text-xl text-ink">Aiployee</span>
        </div>
        <h1 className="text-xl font-heading font-semibold text-ink">Sign in to Aiployee Emailer</h1>
        <Field label="Email"><Input type="email" required value={email} onChange={e => setEmail(e.target.value)} /></Field>
        <Field label="Password"><Input type="password" required value={pw} onChange={e => setPw(e.target.value)} /></Field>
        {err && <div className="text-sm text-error">{err}</div>}
        <Button type="submit" variant="primary">Sign in</Button>
      </form>
    </div>
  );
}
