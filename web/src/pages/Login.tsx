import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { Button } from '../components/Button';
import { Input, Field } from '../components/Input';

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [err, setErr] = useState('');
  return (
    <div className="min-h-screen grid place-items-center bg-surface">
      <form className="bg-bg p-8 rounded-lg w-[380px] shadow border border-line space-y-4"
            onSubmit={async e => { e.preventDefault(); setErr(''); try { await login(email, pw); nav('/'); } catch (x: unknown) { setErr((x as Error).message); } }}>
        <h1 className="text-xl font-heading font-semibold">Sign in to AIployee Emailer</h1>
        <Field label="Email"><Input type="email" required value={email} onChange={e => setEmail(e.target.value)} /></Field>
        <Field label="Password"><Input type="password" required value={pw} onChange={e => setPw(e.target.value)} /></Field>
        {err && <div className="text-sm text-red-600">{err}</div>}
        <Button type="submit" variant="primary">Sign in</Button>
      </form>
    </div>
  );
}
