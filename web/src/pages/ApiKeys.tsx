import { useEffect, useMemo, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { api } from '@aiployee/ui';
import { Table, Th, Td } from '@aiployee/ui';
import { Button } from '@aiployee/ui';
import { Modal } from '@aiployee/ui';
import { Input, Field } from '@aiployee/ui';
import { PageHeader } from '@aiployee/ui';
import { EmptyState } from '@aiployee/ui';
import { Skeleton } from '@aiployee/ui';
import { useToast } from '@aiployee/ui';

interface Key { id: string; name: string; key_prefix: string; parent_id: string | null; created_at: string; last_used_at: string | null; revoked_at: string | null }
interface Sender { id: string; email: string; display_name: string; is_default: boolean }

const PLACEHOLDER_KEY = 'aip_live_XXXXXXXXXXXXXXXXXXXXXXXX';

function endpointUrl() {
  return `${window.location.origin}/v1/emails`;
}

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  const toast = useToast();
  return (
    <button type="button" onClick={async () => {
      await navigator.clipboard.writeText(value);
      setDone(true); setTimeout(() => setDone(false), 1500);
      toast.success('Copied');
    }} className="text-xs px-2 py-1 rounded border border-line hover:bg-surface text-ink-muted hover:text-ink shrink-0">
      {done ? 'Copied' : label}
    </button>
  );
}

function Code({ children, copy }: { children: string; copy?: boolean }) {
  return (
    <div className="relative">
      <pre className="bg-surface-raised rounded-md p-3 text-xs whitespace-pre-wrap break-all font-mono text-ink-muted">{children}</pre>
      {copy && <div className="absolute top-2 right-2"><CopyButton value={children} /></div>}
    </div>
  );
}

function Inline({ children }: { children: string }) {
  return <code className="font-mono bg-surface-raised px-1 py-0.5 rounded text-xs text-ink-muted">{children}</code>;
}

function StepHeader({ n, title }: { n: number; title: string }) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <span className="w-7 h-7 rounded-full bg-brand text-white text-sm font-medium flex items-center justify-center shrink-0">{n}</span>
      <h3 className="text-base font-heading font-semibold text-ink">{title}</h3>
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
  "to": "{{ llm_node_X.recipient_email }}",
  "cc": ["manager@yourcompany.com"],
  "template": "${SAMPLE_TEMPLATE_NAME}",
  "variables": {
    "caller_name": "{{ llm_node_X.caller_name }}",
    "caller_phone": "{{ llm_node_X.caller_phone }}",
    "caller_email": "{{ llm_node_X.caller_email }}",
    "policy_number": "{{ llm_node_X.policy_number }}",
    "id_number": "{{ llm_node_X.id_number }}",
    "summary": "{{ llm_node_X.summary }}"
  }
}`;
}

function IntegrationGuide({ apiKey, fromEmail }: { apiKey: string; fromEmail: string }) {
  const isReal = apiKey !== PLACEHOLDER_KEY;
  const payload = useMemo(() => samplePayload(fromEmail || 'sender@yourdomain.com'), [fromEmail]);

  return (
    <div className="bg-surface border border-line rounded-2xl p-5 space-y-8">
      {isReal && (
        <div className="border border-accent/40 bg-accent/10 text-accent rounded-md p-3 text-sm">
          This is the only time the full key below will be shown. Copy it now and store it securely.
          You can revoke this key at any time from the table — that immediately stops all calls using it.
        </div>
      )}

      <div className="text-sm text-ink-muted">
        This walks through the exact configuration in <strong className="text-ink">Jobix</strong> to send call
        summaries through this tenant's API key. Four steps, ~10 minutes the first time, then it's just
        editing the template.
      </div>

      {/* ───────────────────────────── Step 1 ───────────────────────────── */}
      <section>
        <StepHeader n={1} title="Author the email template in this app" />
        <div className="space-y-3 text-sm">
          <p className="text-ink-muted">
            Sidebar → <strong className="text-ink">Templates</strong> → "New template". Author it{' '}
            <strong className="text-ink">before</strong> configuring Jobix — the placeholder names you put
            in the template have to match the field names you'll set in Jobix.
          </p>

          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="text-xs uppercase text-ink-muted tracking-wide">Suggested template name</div>
              <CopyButton value={SAMPLE_TEMPLATE_NAME} />
            </div>
            <Code>{SAMPLE_TEMPLATE_NAME}</Code>
          </div>

          <div>
            <div className="text-xs uppercase text-ink-muted tracking-wide mb-1">Suggested subject</div>
            <Code copy>{SAMPLE_SUBJECT}</Code>
          </div>

          <div>
            <div className="text-xs uppercase text-ink-muted tracking-wide mb-1">Suggested HTML body</div>
            <Code copy>{SAMPLE_HTML}</Code>
          </div>

          <p className="text-xs text-ink-muted">
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
          <p className="text-ink-muted">
            In your Jobix call flow, add an <strong className="text-ink">LLM</strong> action node
            (Actions → AI → LLM) at the point where you have enough of the conversation to summarize —
            usually right before the call ends.
          </p>
          <p className="text-ink-muted">
            Open the node, switch to the <strong className="text-ink">General</strong> tab, and write a
            system prompt that tells the model to extract caller details + write a short summary. Then in
            the <strong className="text-ink">Output LLM JSON structure</strong> box, paste this schema:
          </p>

          <Code copy>{SAMPLE_LLM_SCHEMA}</Code>

          <p className="text-xs text-ink-muted">
            This locks the LLM's output to these exact field names — it can't drift. Use the same names
            you used as <Inline>{`{{placeholders}}`}</Inline> in Step 1.
          </p>

          <p className="text-xs text-ink-muted">
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
          <p className="text-ink-muted">
            Right after the LLM Summary node, add{' '}
            <strong className="text-ink">Actions → Integrations → Call website/API</strong>.{' '}
            <strong className="text-ink">Don't use the "Webhook" action</strong> — that one only takes
            flat key/value strings and can't send a nested JSON body.
          </p>

          <p className="text-ink-muted">In the node's <strong className="text-ink">General</strong> tab:</p>

          <div className="border border-line rounded-md overflow-hidden text-sm">
            <table className="w-full">
              <tbody className="font-mono">
                <tr className="border-b border-line">
                  <td className="px-3 py-2 bg-surface-raised w-1/3 text-ink-muted">URL</td>
                  <td className="px-3 py-2 break-all text-ink">{endpointUrl()}</td>
                  <td className="px-2 py-2"><CopyButton value={endpointUrl()} /></td>
                </tr>
                <tr className="border-b border-line">
                  <td className="px-3 py-2 bg-surface-raised text-ink-muted">Method</td>
                  <td className="px-3 py-2 text-ink">POST</td>
                  <td></td>
                </tr>
                <tr className="border-b border-line">
                  <td className="px-3 py-2 bg-surface-raised text-ink-muted">Content-Type</td>
                  <td className="px-3 py-2 text-ink">application/json</td>
                  <td></td>
                </tr>
                <tr>
                  <td className="px-3 py-2 bg-surface-raised align-top text-ink-muted">Add header</td>
                  <td className="px-3 py-2 align-top text-ink">
                    <div><span className="text-ink-muted">Key:</span> api_key</div>
                    <div className="break-all"><span className="text-ink-muted">Value:</span> {apiKey}</div>
                  </td>
                  <td className="px-2 py-2 align-top"><CopyButton value={apiKey} label="Copy key" /></td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className="text-ink-muted mt-4">
            Then in the <strong className="text-ink">Edit Payload</strong> box (a strict JSON editor),
            paste exactly this — then do the find-and-replace step underneath:
          </p>

          <Code copy>{payload}</Code>

          <div className="bg-surface-raised border border-line-strong text-ink rounded-md p-3 text-xs space-y-2">
            <p>
              <strong>1. Replace <Inline>llm_node_X</Inline> with your actual LLM node ID.</strong>{' '}
              Jobix auto-assigns IDs like <Inline>llm_node_21</Inline>. To find yours: in the same Call
              website/API node, look at the right-side <strong>Anchors Search</strong> panel → expand your
              LLM node → you'll see the full reference text like{' '}
              <Inline>{`{{ llm_node_21.caller_name }}`}</Inline>. Use the actual ID from there to replace
              every <Inline>llm_node_X</Inline> in the payload above (find &amp; replace in your editor of
              choice, or use the <Inline>+</Inline> button next to each field to insert references one by
              one).
            </p>
            <p>
              <strong>2. Anchors MUST be inside quoted strings.</strong> The editor will show{' '}
              <span className="text-error font-medium">"Invalid JSON"</span> if you paste an anchor
              naked. Wrap every reference in <Inline>"..."</Inline> as in the template above. At runtime
              Jobix interpolates the value into that string — so <Inline>{`"to": "{{ llm_node_21.recipient_email }}"`}</Inline>{' '}
              becomes <Inline>"to": "agent@firstassist.co.za"</Inline>.
            </p>
            <p>
              <strong>3. The <Inline>from</Inline> field</strong> is pre-filled with this tenant's default
              sender (<Inline>{fromEmail || 'set up a sender first'}</Inline>). It must match a sender
              registered for this tenant — see sidebar → Senders.
            </p>
            <p>
              <strong>4. The <Inline>cc</Inline> field is optional</strong> — it copies extra people on
              every email. It's a JSON array, so keep the square brackets and comma-separate addresses:{' '}
              <Inline>{`"cc": ["manager@x.com", "ops@x.com"]`}</Inline>. Replace the sample address with
              real ones, or delete the whole <Inline>cc</Inline> line if you don't need it. (Want the LLM
              to choose the CC per call instead? Add a <Inline>cc_email</Inline> field to the Step 2
              schema and use <Inline>{`"cc": ["{{ llm_node_X.cc_email }}"]`}</Inline>.) A{' '}
              <Inline>bcc</Inline> array works the same way for blind copies.
            </p>
          </div>
        </div>
      </section>

      {/* ───────────────────────────── Step 4 ───────────────────────────── */}
      <section>
        <StepHeader n={4} title="Test the wiring before going live" />
        <div className="space-y-3 text-sm">
          <p className="text-ink-muted">
            In the Call website/API node, switch to the <strong className="text-ink">Response Mapping</strong>
            tab. There's a <strong className="text-ink">Send</strong> button — fire it with whatever mock
            values the LLM is currently producing.
          </p>
          <p className="text-ink-muted">
            Then, in this app, open sidebar → <strong className="text-ink">Email log</strong>. Within a few
            seconds the test fire should appear as a row.
          </p>

          <div className="border border-line rounded-md overflow-hidden text-sm">
            <table className="w-full">
              <thead className="bg-surface-raised text-xs uppercase text-ink-muted">
                <tr><th className="text-left px-3 py-2">If you see</th><th className="text-left px-3 py-2">It means</th></tr>
              </thead>
              <tbody>
                <tr className="border-t border-line">
                  <td className="px-3 py-2 text-ink">Status <strong>sent</strong> + email in your inbox</td>
                  <td className="px-3 py-2 text-ink">Wired correctly. Go live.</td>
                </tr>
                <tr className="border-t border-line">
                  <td className="px-3 py-2 text-ink">Status <strong>failed</strong></td>
                  <td className="px-3 py-2 text-ink">Click the row — the SMTP error is shown verbatim (auth, blocked address, etc).</td>
                </tr>
                <tr className="border-t border-line">
                  <td className="px-3 py-2 text-ink">Email arrives but with literal <Inline>{`{{placeholder}}`}</Inline> text</td>
                  <td className="px-3 py-2 text-ink">A placeholder name in the template doesn't match a key in <Inline>variables</Inline>. Recheck spelling — case-sensitive.</td>
                </tr>
                <tr className="border-t border-line">
                  <td className="px-3 py-2 text-ink">Nothing appears in the log</td>
                  <td className="px-3 py-2 text-ink">Jobix didn't reach us — usually wrong URL, missing <Inline>api_key</Inline> header, or wrong key.</td>
                </tr>
                <tr className="border-t border-line">
                  <td className="px-3 py-2 text-ink">Status <strong>suppressed</strong></td>
                  <td className="px-3 py-2 text-ink">Recipient is on this tenant's suppression list. Not an error — it's intentional.</td>
                </tr>
                <tr className="border-t border-line">
                  <td className="px-3 py-2 text-ink"><strong>"Invalid JSON"</strong> in Jobix's editor (red banner)</td>
                  <td className="px-3 py-2 text-ink">An anchor like <Inline>{`{{ llm_node_21.field }}`}</Inline> was pasted outside of a <Inline>"..."</Inline> string. Wrap every anchor in quotes.</td>
                </tr>
                <tr className="border-t border-line">
                  <td className="px-3 py-2 text-ink">Email arrives but with literal <Inline>{`{{ llm_node_X.summary }}`}</Inline> text</td>
                  <td className="px-3 py-2 text-ink">You didn't replace <Inline>llm_node_X</Inline> with the real node ID. Open Anchors Search to find it.</td>
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
          <p className="text-ink-muted">
            Drop a <strong className="text-ink">second Call website/API node</strong> right after the first
            (or in parallel). Both reference the same LLM Summary node. Use a different{' '}
            <Inline>template</Inline> and <Inline>to</Inline> in each payload.
          </p>
          <p className="text-ink-muted">Example use case — one internal notification, one customer acknowledgement:</p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <div className="border border-line rounded-md p-3 space-y-1 bg-surface-raised">
              <div className="font-medium text-ink">Node A — internal</div>
              <div><span className="text-ink-muted">template:</span> <Inline>internal_call_notify</Inline></div>
              <div><span className="text-ink-muted">to:</span> <Inline>ops@yourcompany.com</Inline></div>
            </div>
            <div className="border border-line rounded-md p-3 space-y-1 bg-surface-raised">
              <div className="font-medium text-ink">Node B — customer</div>
              <div><span className="text-ink-muted">template:</span> <Inline>customer_ack</Inline></div>
              <div><span className="text-ink-muted">to:</span> <Inline>{`{{LLM Summary.caller_email}}`}</Inline></div>
            </div>
          </div>

          <p className="text-xs text-ink-muted">
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
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [subParent, setSubParent] = useState<Key | null>(null);
  const [created, setCreated] = useState<{ key: string } | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const toast = useToast();

  const fromEmail = useMemo(() => {
    if (!senders.length) return '';
    return (senders.find(s => s.is_default) ?? senders[0]).email;
  }, [senders]);

  const refresh = () => api<{ keys: Key[] }>('/api/api-keys').then(r => { setItems(r.keys); setLoading(false); });
  useEffect(() => {
    refresh();
    api<{ senders: Sender[] }>('/api/senders').then(r => setSenders(r.senders)).catch(() => {});
  }, []);

  async function revoke(k: Key) {
    const msg = k.parent_id === null
      ? `Revoke ${k.name}? This also revokes its sub-keys.`
      : `Revoke ${k.name}?`;
    if (!confirm(msg)) return;
    try {
      await api(`/api/api-keys/${k.id}`, { method: 'DELETE' });
      toast.success('Key revoked.');
      refresh();
    } catch (e: unknown) {
      toast.error('Revoke failed: ' + (e as Error).message);
    }
  }

  async function purge(k: Key) {
    const msg = k.parent_id === null
      ? `Permanently delete ${k.name}? This also removes its sub-keys and can't be undone.`
      : `Permanently delete ${k.name}? This can't be undone.`;
    if (!confirm(msg)) return;
    try {
      await api(`/api/api-keys/${k.id}/permanent`, { method: 'DELETE' });
      toast.success('Key deleted.');
      refresh();
    } catch (e: unknown) {
      toast.error('Delete failed: ' + (e as Error).message);
    }
  }

  const masters = items.filter(k => k.parent_id === null);
  const childrenOf = (id: string) => items.filter(k => k.parent_id === id);
  const renderRow = (k: Key, sub: boolean) => (
    <tr key={k.id} className={sub ? 'bg-surface-raised/40' : ''}>
      <Td>
        <span className={`flex items-center gap-1 ${sub ? 'pl-6 text-ink-muted' : 'text-ink'}`}>
          {sub && <span className="text-ink-dim">↳</span>}{k.name}
        </span>
      </Td>
      <Td className="font-mono">{k.key_prefix}…</Td>
      <Td>{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'}</Td>
      <Td>{k.revoked_at ? 'revoked' : 'active'}</Td>
      <Td>
        <div className="flex justify-end gap-2">
          {!k.revoked_at && k.parent_id === null && (
            <Button variant="secondary" onClick={() => setSubParent(k)}>Add sub-key</Button>
          )}
          {!k.revoked_at && <Button variant="danger" onClick={() => revoke(k)}>Revoke</Button>}
          {k.revoked_at && <Button variant="danger" onClick={() => purge(k)}>Delete</Button>}
        </div>
      </Td>
    </tr>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="API keys"
        subtitle="Keys used to authenticate calls from Jobix."
        actions={
          <>
            <Button variant="ghost" onClick={() => setGuideOpen(true)}>Jobix setup guide</Button>
            <Button onClick={() => setOpen(true)}>Generate</Button>
          </>
        }
      />

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map(i => <Skeleton key={i} className="h-9" />)}
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={KeyRound} title="No API keys" description="Create a key to integrate Jobix." />
      ) : (
        <Table>
          <thead><tr><Th>Name</Th><Th>Prefix</Th><Th>Last used</Th><Th>Status</Th><Th>{''}</Th></tr></thead>
          <tbody>{masters.flatMap(m => [renderRow(m, false), ...childrenOf(m.id).map(c => renderRow(c, true))])}</tbody>
        </Table>
      )}

      <Modal open={open || !!subParent} onClose={() => { setOpen(false); setSubParent(null); }}
        title={subParent ? `Add sub-key under “${subParent.name}”` : 'Generate API key'}>
        <Generate parentId={subParent?.id}
          onDone={key => { setCreated({ key }); setOpen(false); setSubParent(null); refresh(); }} />
      </Modal>

      <Modal open={!!created} onClose={() => setCreated(null)} title="Your new API key — Jobix setup guide">
        {created && <IntegrationGuide apiKey={created.key} fromEmail={fromEmail} />}
        <div className="flex justify-end mt-4">
          <Button onClick={() => setCreated(null)}>Done</Button>
        </div>
      </Modal>

      <Modal open={guideOpen} onClose={() => setGuideOpen(false)} title="Jobix setup guide">
        <IntegrationGuide apiKey={PLACEHOLDER_KEY} fromEmail={fromEmail} />
        <p className="text-xs text-ink-muted mt-3">
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

function Generate({ onDone, parentId }: { onDone: (plaintext: string) => void; parentId?: string }) {
  const [name, setName] = useState('');
  const toast = useToast();
  return (
    <form className="space-y-3" onSubmit={async e => {
      e.preventDefault();
      try {
        const r = await api<{ plaintext: string }>('/api/api-keys', {
          method: 'POST', body: JSON.stringify(parentId ? { name, parentId } : { name }),
        });
        toast.success(parentId ? 'Sub-key generated.' : 'API key generated.');
        onDone(r.plaintext);
      } catch (e: unknown) {
        toast.error('Failed to generate key: ' + (e as Error).message);
      }
    }}>
      <Field label={parentId ? 'Flow / sub-key name' : 'Name'}
        hint={parentId ? 'Label this sub-key by the flow it powers (e.g. "Cold outreach").' : undefined}>
        <Input required value={name} onChange={e => setName(e.target.value)} />
      </Field>
      <div className="flex justify-end"><Button type="submit">Generate</Button></div>
    </form>
  );
}
