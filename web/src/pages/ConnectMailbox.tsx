import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '@aiployee/ui';
import { Logo } from '@aiployee/ui';

type View =
  | { state: 'invalid' | 'expired' | 'used' | 'needs_start' }
  | { state: 'waiting'; mailbox: string; userCode: string; verificationUri: string; expiresAt: string; restarted?: boolean }
  | { state: 'connected'; mailbox: string }
  | { state: 'mismatch'; mailbox: string; message: string }
  | { state: 'declined' | 'failed'; message: string };

const POLL_MS = 5000;

// Public page opened from the emailed link. The token is only ever sent in POST bodies and the
// Microsoft device_code never reaches the browser; this page only sees the short user_code.
export default function ConnectMailbox() {
  const { token = '' } = useParams<{ token: string }>();
  const [view, setView] = useState<View | null>(null);
  const [net, setNet] = useState('');
  const [copied, setCopied] = useState(false);
  const stopped = useRef(false);

  useEffect(() => {
    // Keep the secret link out of Referer headers and indexes.
    const m = document.createElement('meta');
    m.name = 'referrer'; m.content = 'no-referrer';
    const r = document.createElement('meta');
    r.name = 'robots'; r.content = 'noindex,nofollow';
    document.head.append(m, r);
    return () => { m.remove(); r.remove(); };
  }, []);

  const call = useCallback(async (kind: 'start' | 'status') => {
    try {
      const v = await api<View>(`/api/public/m365-connect/${kind}`, { method: 'POST', body: JSON.stringify({ token }) });
      setNet('');
      setView(v);
      return v;
    } catch (e) {
      setNet((e as Error).message || 'Connection problem. Retrying…');
      return null;
    }
  }, [token]);

  useEffect(() => {
    stopped.current = false;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async (first: boolean) => {
      if (stopped.current) return;
      const v = await call(first ? 'start' : 'status');
      if (stopped.current) return;
      if (v?.state === 'needs_start') { await call('start'); }
      const terminal = v && ['invalid', 'expired', 'used', 'connected', 'declined', 'failed', 'mismatch'].includes(v.state);
      if (!terminal) timer = setTimeout(() => loop(false), POLL_MS);
    };
    void loop(true);
    return () => { stopped.current = true; clearTimeout(timer); };
  }, [call]);

  const tryAgain = async () => {
    stopped.current = false;
    setView(null);
    const v = await call('start');
    if (v?.state === 'waiting') {
      const tick = async () => {
        if (stopped.current) return;
        const s = await call('status');
        if (s && s.state === 'waiting') setTimeout(tick, POLL_MS);
      };
      setTimeout(tick, POLL_MS);
    }
  };

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* user can select the code */ }
  };

  return (
    <div className="min-h-screen grid place-items-center p-4 bg-surface">
      <div className="bg-surface-raised border border-line-strong p-8 rounded-2xl w-full max-w-[480px] shadow-glow space-y-4">
        <div className="flex items-center gap-2 mb-2">
          <Logo size={36} />
          <span className="font-heading font-semibold text-xl text-ink">Aiployee</span>
        </div>

        {!view && <p className="text-ink">{net || 'Getting your sign-in code…'}</p>}

        {view?.state === 'waiting' && (
          <>
            <h1 className="text-xl font-heading font-semibold text-ink">Connect {view.mailbox}</h1>
            {view.restarted && (
              <div className="text-sm rounded-lg border border-line-strong p-3 text-ink" role="status">
                The previous code timed out, so we made you a new one. Use the code below.
              </div>
            )}
            <ol className="list-decimal pl-5 space-y-2 text-ink">
              <li>Open <a className="underline text-brand" href={view.verificationUri} target="_blank" rel="noopener noreferrer">{view.verificationUri.replace(/^https:\/\//, '')}</a></li>
              <li>Enter this code:</li>
            </ol>
            <div className="flex items-center gap-3">
              <div className="flex-1 text-center text-3xl font-mono font-bold tracking-[0.25em] rounded-xl border border-line-strong py-4 text-ink select-all" aria-label="Your code">{view.userCode}</div>
              <button type="button" onClick={() => copy(view.userCode)}
                className="px-4 py-3 rounded-lg border border-line-strong text-ink">{copied ? 'Copied' : 'Copy'}</button>
            </div>
            <ol className="list-decimal pl-5 text-ink" start={3}>
              <li>Sign in as <strong>{view.mailbox}</strong> and click <strong>Accept</strong>.</li>
            </ol>
            <p className="text-sm text-ink-muted">Keep this page open. It updates by itself when you are done.</p>
            {net && <p className="text-sm text-error">{net}</p>}
          </>
        )}

        {view?.state === 'connected' && (
          <>
            <h1 className="text-xl font-heading font-semibold text-ink">Connected ✓</h1>
            <p className="text-ink"><strong>{view.mailbox}</strong> can now send email through Aiployee. You can close this page.</p>
          </>
        )}

        {view?.state === 'mismatch' && (
          <>
            <h1 className="text-xl font-heading font-semibold text-ink">Wrong account</h1>
            <p className="text-error">{view.message}</p>
            <button type="button" onClick={tryAgain} className="px-4 py-2 rounded-lg bg-brand text-white">Get a new code</button>
          </>
        )}

        {view && (view.state === 'declined' || view.state === 'failed') && (
          <>
            <h1 className="text-xl font-heading font-semibold text-ink">Not connected</h1>
            <p className="text-error">{view.message}</p>
          </>
        )}

        {view?.state === 'invalid' && (
          <>
            <h1 className="text-xl font-heading font-semibold text-ink">Link not valid</h1>
            <p className="text-ink">This link is not valid. Please check you copied the whole link, or ask for a new one.</p>
          </>
        )}
        {view?.state === 'expired' && (
          <>
            <h1 className="text-xl font-heading font-semibold text-ink">Link expired</h1>
            <p className="text-ink">This link has expired. Please ask for a new one.</p>
          </>
        )}
        {view?.state === 'used' && (
          <>
            <h1 className="text-xl font-heading font-semibold text-ink">Link already used</h1>
            <p className="text-ink">This link has already been used. If you still need to connect a mailbox, ask for a new one.</p>
          </>
        )}
      </div>
    </div>
  );
}
