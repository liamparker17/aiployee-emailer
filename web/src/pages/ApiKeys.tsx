import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Table, Th, Td } from '../components/Table';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Input, Field } from '../components/Input';

interface Key { id: string; name: string; key_prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null }
interface Sender { id: string; email: string; display_name: string; is_default: boolean }

const PLACEHOLDER_KEY = 'aip_live_XXXXXXXXXXXXXXXXXXXXXXXX';

function endpointUrl() {
  return `${window.location.origin}/v1/emails`;
}

function sampleBody(fromEmail: string) {
  return {
    from: fromEmail,
    to: 'recipient@example.com',
    subject: 'Hello from Jobix',
    html: '<p>Hi {{candidate_name}},</p><p>{{message_body}}</p>',
  };
}

function curlSnippet(key: string, fromEmail: string) {
  const body = JSON.stringify(sampleBody(fromEmail), null, 2);
  return [
    `curl -X POST ${endpointUrl()} \\`,
    `  -H "Authorization: Bearer ${key}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${body}'`,
  ].join('\n');
}

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" onClick={async () => {
      await navigator.clipboard.writeText(value);
      setDone(true); setTimeout(() => setDone(false), 1500);
    }} className="text-xs px-2 py-1 rounded border border-line hover:bg-surface text-muted hover:text-ink">
      {done ? 'Copied' : label}
    </button>
  );
}

function CodeBlock({ children, copy }: { children: string; copy?: boolean }) {
  return (
    <div className="relative">
      <pre className="bg-surface rounded-md p-3 text-xs whitespace-pre-wrap break-all font-mono">{children}</pre>
      {copy && <div className="absolute top-2 right-2"><CopyButton value={children} /></div>}
    </div>
  );
}

function IntegrationGuide({ apiKey, fromEmail }: { apiKey: string; fromEmail: string }) {
  const body = useMemo(() => JSON.stringify(sampleBody(fromEmail), null, 2), [fromEmail]);
  const curl = useMemo(() => curlSnippet(apiKey, fromEmail), [apiKey, fromEmail]);
  const isReal = apiKey !== PLACEHOLDER_KEY;

  return (
    <div className="space-y-5">
      {isReal && (
        <div className="border border-yellow-300 bg-yellow-50 text-yellow-900 rounded-md p-3 text-sm">
          This is the only time the full key will be shown. Copy it now and store it securely.
        </div>
      )}

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">API key</h3>
          {isReal && <CopyButton value={apiKey} />}
        </div>
        <CodeBlock>{apiKey}</CodeBlock>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Endpoint</h3>
          <CopyButton value={endpointUrl()} />
        </div>
        <CodeBlock>{`POST ${endpointUrl()}`}</CodeBlock>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Headers</h3>
        <CodeBlock copy>{`Authorization: Bearer ${apiKey}\nContent-Type: application/json`}</CodeBlock>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">JSON body</h3>
        <CodeBlock copy>{body}</CodeBlock>
        <p className="text-xs text-muted">
          Provide either <code className="font-mono">subject</code> + <code className="font-mono">html</code>{' '}
          or a stored <code className="font-mono">template</code> + <code className="font-mono">variables</code>.
          Optional fields: <code className="font-mono">cc</code>, <code className="font-mono">bcc</code>,{' '}
          <code className="font-mono">reply_to</code>, <code className="font-mono">text</code>,{' '}
          <code className="font-mono">attachments</code>, <code className="font-mono">scheduled_for</code>.
        </p>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">curl</h3>
        <CodeBlock copy>{curl}</CodeBlock>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Response</h3>
        <CodeBlock>{`202 { "id": "...", "status": "sent" | "queued" | "failed" | "suppressed", "message_id": "...", "error": null }`}</CodeBlock>
        <p className="text-xs text-muted">
          A <code className="font-mono">suppressed</code> recipient still returns 202 — not an error.
          Branch on <code className="font-mono">status</code> explicitly if you care.
        </p>
      </section>
    </div>
  );
}

export default function ApiKeys() {
  const [items, setItems] = useState<Key[]>([]);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<{ key: string } | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

  const fromEmail = useMemo(() => {
    if (!senders.length) return 'sender@yourdomain.com';
    return (senders.find(s => s.is_default) ?? senders[0]).email;
  }, [senders]);

  const refresh = () => api<{ keys: Key[] }>('/api/api-keys').then(r => setItems(r.keys));
  useEffect(() => {
    refresh();
    api<{ senders: Sender[] }>('/api/senders').then(r => setSenders(r.senders)).catch(() => {});
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-heading font-semibold">API keys</h1>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setGuideOpen(true)}>Integration guide</Button>
          <Button onClick={() => setOpen(true)}>Generate</Button>
        </div>
      </div>

      <Table>
        <thead><tr><Th>Name</Th><Th>Prefix</Th><Th>Last used</Th><Th>Status</Th><Th>{''}</Th></tr></thead>
        <tbody>{items.map(k => (
          <tr key={k.id}>
            <Td>{k.name}</Td><Td className="font-mono">{k.key_prefix}…</Td>
            <Td>{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'}</Td>
            <Td>{k.revoked_at ? 'revoked' : 'active'}</Td>
            <Td>{!k.revoked_at && <Button variant="danger" onClick={async () => {
              if (!confirm(`Revoke ${k.name}?`)) return;
              await api(`/api/api-keys/${k.id}`, { method: 'DELETE' }); refresh();
            }}>Revoke</Button>}</Td>
          </tr>
        ))}</tbody>
      </Table>

      <Modal open={open} onClose={() => setOpen(false)} title="Generate API key">
        <Generate onDone={key => { setCreated({ key }); setOpen(false); refresh(); }} />
      </Modal>

      <Modal open={!!created} onClose={() => setCreated(null)} title="Your new API key">
        {created && <IntegrationGuide apiKey={created.key} fromEmail={fromEmail} />}
        <div className="flex justify-end mt-4">
          <Button onClick={() => setCreated(null)}>Done</Button>
        </div>
      </Modal>

      <Modal open={guideOpen} onClose={() => setGuideOpen(false)} title="Integration guide">
        <IntegrationGuide apiKey={PLACEHOLDER_KEY} fromEmail={fromEmail} />
        <p className="text-xs text-muted mt-3">
          Replace <code className="font-mono">{PLACEHOLDER_KEY}</code> with a real key from the table above.
          Generate a new one if you don't have it.
        </p>
        <div className="flex justify-end mt-4">
          <Button onClick={() => setGuideOpen(false)}>Close</Button>
        </div>
      </Modal>
    </div>
  );
}

function Generate({ onDone }: { onDone: (plaintext: string) => void }) {
  const [name, setName] = useState('');
  return (
    <form className="space-y-3" onSubmit={async e => {
      e.preventDefault();
      const r = await api<{ plaintext: string }>('/api/api-keys', { method: 'POST', body: JSON.stringify({ name }) });
      onDone(r.plaintext);
    }}>
      <Field label="Name"><Input required value={name} onChange={e => setName(e.target.value)} /></Field>
      <div className="flex justify-end"><Button type="submit">Generate</Button></div>
    </form>
  );
}
