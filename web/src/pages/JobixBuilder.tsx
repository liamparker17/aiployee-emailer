import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { api } from '@aiployee/ui';
import { Field, Input } from '@aiployee/ui';
import { PageHeader } from '@aiployee/ui';
import { EmptyState } from '@aiployee/ui';
import { Skeleton } from '@aiployee/ui';
import { CopyButton } from '@aiployee/ui';

interface Template { id: string; name: string; variables: string[] }
interface Sender { id: string; email: string; display_name: string; is_default: boolean }

function CodeBlock({ title, json }: { title: string; json: string }) {
  return (
    <div className="bg-surface border border-line rounded-2xl p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs uppercase tracking-wide text-ink-dim">{title}</div>
        <CopyButton value={json} />
      </div>
      <pre className="bg-surface-raised rounded-lg p-3 text-xs whitespace-pre-wrap break-all font-mono text-ink-muted">{json}</pre>
    </div>
  );
}

const selectCls = 'w-full rounded-lg border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent';

export default function JobixBuilder() {
  const { tenantId } = useParams<{ tenantId: string }>();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [loading, setLoading] = useState(true);

  const [templateId, setTemplateId] = useState('');
  const [from, setFrom] = useState('');
  const [recipientMode, setRecipientMode] = useState<'llm' | 'fixed'>('llm');
  const [fixedTo, setFixedTo] = useState('');
  const [nodeRef, setNodeRef] = useState('llm_node_X');
  const [extra, setExtra] = useState('');

  useEffect(() => {
    Promise.all([
      api<{ templates: Template[] }>('/api/templates'),
      api<{ senders: Sender[] }>('/api/senders').catch(() => ({ senders: [] as Sender[] })),
    ]).then(([t, s]) => {
      setTemplates(t.templates);
      setSenders(s.senders);
      if (t.templates[0]) setTemplateId(t.templates[0].id);
      const def = s.senders.find(x => x.is_default) ?? s.senders[0];
      if (def) setFrom(def.email);
      setLoading(false);
    });
  }, []);

  const template = templates.find(t => t.id === templateId);

  const fields = useMemo(() => {
    const base = template?.variables ?? [];
    const extras = extra.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    return Array.from(new Set([...base, ...extras]));
  }, [template, extra]);

  const ref = nodeRef.trim() || 'llm_node_X';
  const anchor = (field: string) => `{{ ${ref}.${field} }}`;

  const schemaJson = useMemo(() => {
    const obj: Record<string, string> = {};
    for (const f of fields) obj[f] = 'string';
    if (recipientMode === 'llm') obj.recipient_email = 'string';
    return JSON.stringify(obj, null, 2);
  }, [fields, recipientMode]);

  const payloadJson = useMemo(() => {
    const variables: Record<string, string> = {};
    for (const f of fields) variables[f] = anchor(f);
    const payload = {
      from: from || 'sender@yourdomain.com',
      to: recipientMode === 'llm' ? anchor('recipient_email') : (fixedTo || 'recipient@example.com'),
      template: template?.name ?? '',
      variables,
    };
    return JSON.stringify(payload, null, 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, from, recipientMode, fixedTo, template, ref]);

  const configJson = useMemo(() => JSON.stringify({
    method: 'POST',
    url: `${window.location.origin}/v1/emails`,
    headers: { 'Content-Type': 'application/json', api_key: '<paste your API key>' },
  }, null, 2), []);

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Jobix builder" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  if (templates.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Jobix builder" subtitle="Generate the JSON for your Jobix LLM + Web-call nodes." />
        <EmptyState
          icon={FileText}
          title="No templates yet"
          description="The builder generates JSON from a saved template's variables. Create a template first."
          action={<Link to={`/t/${tenantId}/templates`} className="text-magenta hover:underline text-sm">Go to Templates →</Link>}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Jobix builder" subtitle="Pick a template and the builder generates the JSON to paste into your Jobix LLM node and Web-call API node." />

      <div className="bg-surface border border-line rounded-2xl p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Template" hint="The payload variables are derived from this template's placeholders.">
          <select className={selectCls} value={templateId} onChange={e => setTemplateId(e.target.value)}>
            {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <Field label="From (sender)">
          {senders.length > 0 ? (
            <select className={selectCls} value={from} onChange={e => setFrom(e.target.value)}>
              {senders.map(s => <option key={s.id} value={s.email}>{s.display_name} — {s.email}</option>)}
            </select>
          ) : (
            <Input value={from} onChange={e => setFrom(e.target.value)} placeholder="sender@yourdomain.com" />
          )}
        </Field>
        <Field label="Recipient">
          <select className={selectCls} value={recipientMode} onChange={e => setRecipientMode(e.target.value as 'llm' | 'fixed')}>
            <option value="llm">LLM extracts it (adds recipient_email to schema)</option>
            <option value="fixed">Fixed address</option>
          </select>
        </Field>
        {recipientMode === 'fixed'
          ? <Field label="Fixed recipient address"><Input type="email" value={fixedTo} onChange={e => setFixedTo(e.target.value)} placeholder="ops@yourcompany.com" /></Field>
          : <Field label="LLM node reference" hint='Replace with the real node id from Jobix Anchors Search, e.g. "llm_node_21".'><Input value={nodeRef} onChange={e => setNodeRef(e.target.value)} /></Field>}
        {recipientMode === 'fixed' && (
          <Field label="LLM node reference" hint='Used in the variable anchors, e.g. "llm_node_21".'><Input value={nodeRef} onChange={e => setNodeRef(e.target.value)} /></Field>
        )}
        <Field label="Extra fields (optional)" hint="Space/comma separated — added to the schema and payload beyond the template's variables.">
          <Input value={extra} onChange={e => setExtra(e.target.value)} placeholder="caller_phone id_number" />
        </Field>
      </div>

      <CodeBlock title="① Jobix LLM node — Output JSON schema" json={schemaJson} />
      <CodeBlock title="② Jobix Web-call API node — Payload (JSON body)" json={payloadJson} />
      <CodeBlock title="③ Web-call node config (URL · method · headers)" json={configJson} />

      <p className="text-xs text-ink-dim">
        Paste ① into the LLM node's locked Output schema and ② into the Web-call node's body. Every anchor
        ({`{{ ${ref}.field }}`}) must stay inside its quotes or Jobix reports "Invalid JSON". Full walkthrough
        lives on the <Link to={`/t/${tenantId}/api-keys`} className="text-magenta hover:underline">API keys</Link> page.
      </p>
    </div>
  );
}
