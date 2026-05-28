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

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" onClick={async () => {
      await navigator.clipboard.writeText(value);
      setDone(true); setTimeout(() => setDone(false), 1500);
    }} className="text-xs px-2 py-1 rounded border border-line hover:bg-surface text-muted hover:text-ink shrink-0">
      {done ? 'Copied' : label}
    </button>
  );
}

function Code({ children, copy }: { children: string; copy?: boolean }) {
  return (
    <div className="relative">
      <pre className="bg-surface rounded-md p-3 text-xs whitespace-pre-wrap break-all font-mono">{children}</pre>
      {copy && <div className="absolute top-2 right-2"><CopyButton value={children} /></div>}
    </div>
  );
}

function Inline({ children }: { children: string }) {
  return <code className="font-mono bg-surface px-1 py-0.5 rounded text-xs">{children}</code>;
}

function StepHeader({ n, title }: { n: number; title: string }) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <span className="w-7 h-7 rounded-full bg-ink text-white text-sm font-medium flex items-center justify-center shrink-0">{n}</span>
      <h3 className="text-base font-heading font-semibold">{title}</h3>
    </div>
  );
}

const SAMPLE_TEMPLATE_NAME = 'call_summary';
const SAMPLE_SUBJECT = 'New call — {{caller_name}} (policy {{policy_number}})';
const SAMPLE_HTML = `<p>A new call came in:</p>
<table style="border-collapse:collapse;">
  <tr><td><strong>Caller:</strong></td><td>{{caller_name}}</td></tr>
  <tr><td><strong>Phone:</strong></td><td>{{caller_phone}}</td></tr>
  <tr><td><strong>Email:</strong></td><td>{{caller_email}}</td></tr>
  <tr><td><strong>Policy #:</strong></td><td>{{policy_number}}</td></tr>
  <tr><td><strong>ID #:</strong></td><td>{{id_number}}</td></tr>
</table>
<p><strong>Call summary:</strong></p>
<p>{{summary}}</p>`;

const SAMPLE_LLM_SCHEMA = `{
  "caller_name": "string",
  "caller_phone": "string",
  "caller_email": "string",
  "policy_number": "string",
  "id_number": "string",
  "summary": "string",
  "recipient_email": "string"
}`;

function samplePayload(fromEmail: string) {
  return `{
  "from": "${fromEmail}",
  "to": "{{LLM Summary.recipient_email}}",
  "template": "${SAMPLE_TEMPLATE_NAME}",
  "variables": {
    "caller_name": "{{LLM Summary.caller_name}}",
    "caller_phone": "{{LLM Summary.caller_phone}}",
    "caller_email": "{{LLM Summary.caller_email}}",
    "policy_number": "{{LLM Summary.policy_number}}",
    "id_number": "{{LLM Summary.id_number}}",
    "summary": "{{LLM Summary.summary}}"
  }
}`;
}

function IntegrationGuide({ apiKey, fromEmail }: { apiKey: string; fromEmail: string }) {
  const isReal = apiKey !== PLACEHOLDER_KEY;
  const payload = useMemo(() => samplePayload(fromEmail || 'sender@yourdomain.com'), [fromEmail]);

  return (
    <div className="space-y-8">
      {isReal && (
        <div className="border border-yellow-300 bg-yellow-50 text-yellow-900 rounded-md p-3 text-sm">
          This is the only time the full key below will be shown. Copy it now and store it securely.
          You can revoke this key at any time from the table — that immediately stops all calls using it.
        </div>
      )}

      <div className="text-sm text-muted">
        This walks through the exact configuration in <strong className="text-ink">Jobix</strong> to send call
        summaries through this tenant's API key. Four steps, ~10 minutes the first time, then it's just
        editing the template.
      </div>

      {/* ───────────────────────────── Step 1 ───────────────────────────── */}
      <section>
        <StepHeader n={1} title="Author the email template in this app" />
        <div className="space-y-3 text-sm">
          <p className="text-muted">
            Sidebar → <strong className="text-ink">Templates</strong> → "New template". Author it{' '}
            <strong className="text-ink">before</strong> configuring Jobix — the placeholder names you put
            in the template have to match the field names you'll set in Jobix.
          </p>

          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="text-xs uppercase text-muted tracking-wide">Suggested template name</div>
              <CopyButton value={SAMPLE_TEMPLATE_NAME} />
            </div>
            <Code>{SAMPLE_TEMPLATE_NAME}</Code>
          </div>

          <div>
            <div className="text-xs uppercase text-muted tracking-wide mb-1">Suggested subject</div>
            <Code copy>{SAMPLE_SUBJECT}</Code>
          </div>

          <div>
            <div className="text-xs uppercase text-muted tracking-wide mb-1">Suggested HTML body</div>
            <Code copy>{SAMPLE_HTML}</Code>
          </div>

          <p className="text-xs text-muted">
            The placeholders <Inline>{`{{caller_name}}`}</Inline>, <Inline>{`{{summary}}`}</Inline>, etc.
            will be filled at send time from the JSON Jobix sends us. Keep the spelling exact — a mismatch
            doesn't error, it just renders the literal placeholder text in the email.
          </p>
        </div>
      </section>

      {/* ───────────────────────────── Step 2 ───────────────────────────── */}
      <section>
        <StepHeader n={2} title="Add an LLM summary node in Jobix" />
        <div className="space-y-3 text-sm">
          <p className="text-muted">
            In your Jobix call flow, add an <strong className="text-ink">LLM</strong> action node
            (Actions → AI → LLM) at the point where you have enough of the conversation to summarize —
            usually right before the call ends.
          </p>
          <p className="text-muted">
            Open the node, switch to the <strong className="text-ink">General</strong> tab, and write a
            system prompt that tells the model to extract caller details + write a short summary. Then in
            the <strong className="text-ink">Output LLM JSON structure</strong> box, paste this schema:
          </p>

          <Code copy>{SAMPLE_LLM_SCHEMA}</Code>

          <p className="text-xs text-muted">
            This locks the LLM's output to these exact field names — it can't drift. Use the same names
            you used as <Inline>{`{{placeholders}}`}</Inline> in Step 1.
          </p>

          <p className="text-xs text-muted">
            <strong className="text-ink">Rename the node</strong> from "Unnamed LLM node" to something
            stable like <Inline>LLM Summary</Inline> — Jobix uses the node name in variable references,
            and a rename later will break them.
          </p>
        </div>
      </section>

      {/* ───────────────────────────── Step 3 ───────────────────────────── */}
      <section>
        <StepHeader n={3} title="Add a Call website/API node in Jobix" />
        <div className="space-y-3 text-sm">
          <p className="text-muted">
            Right after the LLM Summary node, add{' '}
            <strong className="text-ink">Actions → Integrations → Call website/API</strong>.{' '}
            <strong className="text-ink">Don't use the "Webhook" action</strong> — that one only takes
            flat key/value strings and can't send a nested JSON body.
          </p>

          <p className="text-muted">In the node's <strong className="text-ink">General</strong> tab:</p>

          <div className="border border-line rounded-md overflow-hidden text-sm">
            <table className="w-full">
              <tbody className="font-mono">
                <tr className="border-b border-line">
                  <td className="px-3 py-2 bg-surface w-1/3">URL</td>
                  <td className="px-3 py-2 break-all">{endpointUrl()}</td>
                  <td className="px-2 py-2"><CopyButton value={endpointUrl()} /></td>
                </tr>
                <tr className="border-b border-line">
                  <td className="px-3 py-2 bg-surface">Method</td>
                  <td className="px-3 py-2">POST</td>
                  <td></td>
                </tr>
                <tr className="border-b border-line">
                  <td className="px-3 py-2 bg-surface">Content-Type</td>
                  <td className="px-3 py-2">application/json</td>
                  <td></td>
                </tr>
                <tr>
                  <td className="px-3 py-2 bg-surface align-top">Add header</td>
                  <td className="px-3 py-2 align-top">
                    <div><span className="text-muted">Key:</span> api_key</div>
                    <div className="break-all"><span className="text-muted">Value:</span> {apiKey}</div>
                  </td>
                  <td className="px-2 py-2 align-top"><CopyButton value={apiKey} label="Copy key" /></td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className="text-muted mt-4">
            Then in the <strong className="text-ink">Edit Payload</strong> box (the free-form JSON editor),
            paste exactly this:
          </p>

          <Code copy>{payload}</Code>

          <div className="bg-surface border border-line rounded-md p-3 text-xs space-y-2">
            <p>
              <strong>Anchor references.</strong> The <Inline>{`{{LLM Summary.field_name}}`}</Inline>{' '}
              syntax assumes you renamed the LLM node to <Inline>LLM Summary</Inline> in Step 2. If you used
              a different name, swap it in — Jobix's right-side "Anchors Search" panel will show you the
              exact reference text when you click a field, so when in doubt use that.
            </p>
            <p>
              <strong>The <Inline>from</Inline> field</strong> is pre-filled with this tenant's default
              sender (<Inline>{fromEmail || 'set up a sender first'}</Inline>). It must match a sender
              registered for this tenant — see sidebar → Senders.
            </p>
          </div>
        </div>
      </section>

      {/* ───────────────────────────── Step 4 ───────────────────────────── */}
      <section>
        <StepHeader n={4} title="Test the wiring before going live" />
        <div className="space-y-3 text-sm">
          <p className="text-muted">
            In the Call website/API node, switch to the <strong className="text-ink">Response Mapping</strong>
            tab. There's a <strong className="text-ink">Send</strong> button — fire it with whatever mock
            values the LLM is currently producing.
          </p>
          <p className="text-muted">
            Then, in this app, open sidebar → <strong className="text-ink">Email log</strong>. Within a few
            seconds the test fire should appear as a row.
          </p>

          <div className="border border-line rounded-md overflow-hidden text-sm">
            <table className="w-full">
              <thead className="bg-surface text-xs uppercase text-muted">
                <tr><th className="text-left px-3 py-2">If you see</th><th className="text-left px-3 py-2">It means</th></tr>
              </thead>
              <tbody>
                <tr className="border-t border-line">
                  <td className="px-3 py-2">Status <strong>sent</strong> + email in your inbox</td>
                  <td className="px-3 py-2">Wired correctly. Go live.</td>
                </tr>
                <tr className="border-t border-line">
                  <td className="px-3 py-2">Status <strong>failed</strong></td>
                  <td className="px-3 py-2">Click the row — the SMTP error is shown verbatim (auth, blocked address, etc).</td>
                </tr>
                <tr className="border-t border-line">
                  <td className="px-3 py-2">Email arrives but with literal <Inline>{`{{placeholder}}`}</Inline> text</td>
                  <td className="px-3 py-2">A placeholder name in the template doesn't match a key in <Inline>variables</Inline>. Recheck spelling — case-sensitive.</td>
                </tr>
                <tr className="border-t border-line">
                  <td className="px-3 py-2">Nothing appears in the log</td>
                  <td className="px-3 py-2">Jobix didn't reach us — usually wrong URL, missing <Inline>api_key</Inline> header, or wrong key.</td>
                </tr>
                <tr className="border-t border-line">
                  <td className="px-3 py-2">Status <strong>suppressed</strong></td>
                  <td className="px-3 py-2">Recipient is on this tenant's suppression list. Not an error — it's intentional.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ───────────────────────────── Bonus: two emails ───────────────────────────── */}
      <section>
        <StepHeader n={5} title="Optional: send more than one email per call" />
        <div className="space-y-3 text-sm">
          <p className="text-muted">
            Drop a <strong className="text-ink">second Call website/API node</strong> right after the first
            (or in parallel). Both reference the same LLM Summary node. Use a different{' '}
            <Inline>template</Inline> and <Inline>to</Inline> in each payload.
          </p>
          <p className="text-muted">Example use case — one internal notification, one customer acknowledgement:</p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <div className="border border-line rounded-md p-3 space-y-1">
              <div className="font-medium">Node A — internal</div>
              <div><span className="text-muted">template:</span> <Inline>internal_call_notify</Inline></div>
              <div><span className="text-muted">to:</span> <Inline>ops@yourcompany.com</Inline></div>
            </div>
            <div className="border border-line rounded-md p-3 space-y-1">
              <div className="font-medium">Node B — customer</div>
              <div><span className="text-muted">template:</span> <Inline>customer_ack</Inline></div>
              <div><span className="text-muted">to:</span> <Inline>{`{{LLM Summary.caller_email}}`}</Inline></div>
            </div>
          </div>

          <p className="text-xs text-muted">
            If the LLM should choose recipients dynamically (e.g. emergencies route differently), add fields
            like <Inline>internal_recipient</Inline> and <Inline>customer_recipient</Inline> to the LLM
            schema in Step 2 and reference them in each node's payload.
          </p>
        </div>
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
    if (!senders.length) return '';
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
          <Button variant="ghost" onClick={() => setGuideOpen(true)}>Jobix setup guide</Button>
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

      <Modal open={!!created} onClose={() => setCreated(null)} title="Your new API key — Jobix setup guide">
        {created && <IntegrationGuide apiKey={created.key} fromEmail={fromEmail} />}
        <div className="flex justify-end mt-4">
          <Button onClick={() => setCreated(null)}>Done</Button>
        </div>
      </Modal>

      <Modal open={guideOpen} onClose={() => setGuideOpen(false)} title="Jobix setup guide">
        <IntegrationGuide apiKey={PLACEHOLDER_KEY} fromEmail={fromEmail} />
        <p className="text-xs text-muted mt-3">
          Replace <code className="font-mono">{PLACEHOLDER_KEY}</code> in the header above with a real key
          from the table. Generate a new key if you don't already have one stored.
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
