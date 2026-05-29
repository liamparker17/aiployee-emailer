import { useEffect, useState } from 'react';
import { Bot, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../api';
import { Button } from '../components/Button';
import { Input, Field } from '../components/Input';
import { Card } from '../components/Card';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';
import { StatusBadge } from '../components/StatusBadge';
import { CopyButton } from '../components/CopyButton';
import { useToast } from '../components/Toast';

interface AgentConfig {
  enabled: boolean; model: string; system_prompt: string;
  auto_approve_jobix: boolean; max_tool_iterations: number; has_key: boolean;
  jobix_webhook_url: string | null; has_webhook_secret: boolean;
}
interface McpServer { id: string; name: string; url: string; enabled: boolean; has_auth: boolean }
interface Thread { id: string; jobix_thread_ref: string; subject: string | null; status: string; updated_at: string }
interface Msg { id: string; role: string; source: string; content: string; status: string; created_at: string }

const selectCls = 'w-full rounded-lg border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent';

const SAMPLE_INGEST = `{
  "thread_ref": "jobix-thread-123",
  "message": "Draft a reply confirming the policy renewal.",
  "context": { "policy_number": "P-4471", "customer_name": "Jane Doe" },
  "message_ref": "jobix-msg-987"
}`;

function IntegrationExplainer() {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <button className="flex items-center gap-2 w-full text-left" onClick={() => setOpen(v => !v)}>
        {open ? <ChevronDown size={16} className="text-ink-dim" /> : <ChevronRight size={16} className="text-ink-dim" />}
        <span className="font-heading font-semibold text-ink">How the agent works with Jobix</span>
      </button>
      {open && (
        <div className="mt-4 space-y-4 text-sm text-ink-muted">
          <p>
            The agent does <strong className="text-ink">not</strong> read real inbound email — <strong className="text-ink">Jobix drives every conversation</strong>.
            The loop is: <em>Jobix → agent runs → action → webhook back to Jobix</em>.
          </p>
          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="text-xs uppercase tracking-wide text-ink-dim">Jobix posts a turn → POST /v1/agent/messages (api_key header)</div>
              <CopyButton value={SAMPLE_INGEST} />
            </div>
            <pre className="bg-surface-raised rounded-lg p-3 text-xs whitespace-pre-wrap break-all font-mono text-ink-muted">{SAMPLE_INGEST}</pre>
          </div>
          <ul className="list-disc pl-5 space-y-1">
            <li><strong className="text-ink">thread_ref</strong> — Jobix's own conversation id; reuse it per conversation so the agent keeps history.</li>
            <li>The endpoint returns <strong className="text-ink">202</strong> immediately; the agent runs and (Phase 1) returns the reply inline as <code className="font-mono">response_text</code>.</li>
            <li><strong className="text-ink">Jobix-sourced messages are auto-approved</strong> and acted on; messages created here in the UI wait for your approval below.</li>
            <li><strong className="text-ink">message_ref</strong> makes retries idempotent.</li>
            <li>MCP tools and RAG (coming in later phases) are configured per-tenant and only improve the reply — Jobix's contract doesn't change.</li>
          </ul>
          <p><strong className="text-ink">Outbound webhook:</strong> set a Jobix webhook URL + secret below and the emailer POSTs an
            <code className="font-mono"> agent.response</code> event back to Jobix on every outcome
            (<code className="font-mono">status</code>: <code className="font-mono">sent</code> / <code className="font-mono">drafted</code> / <code className="font-mono">rejected</code>),
            HMAC-signed in the <code className="font-mono">X-Aiployee-Signature</code> header so Jobix can verify it.</p>
          <p className="text-xs text-ink-dim">Full contract: <code className="font-mono">docs/agent-jobix-integration.md</code>.</p>
        </div>
      )}
    </Card>
  );
}

export default function AiResponses() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [cfg, setCfg] = useState<AgentConfig | null>(null);
  const [form, setForm] = useState({ enabled: false, model: 'gpt-4o', systemPrompt: '', autoApproveJobix: true, maxToolIterations: 4, openaiKey: '', jobixWebhookUrl: '', jobixWebhookSecret: '' });
  const [threads, setThreads] = useState<Thread[]>([]);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, Msg[]>>({});
  const [mcp, setMcp] = useState<McpServer[]>([]);
  const [mcpForm, setMcpForm] = useState({ name: '', url: '', authHeader: '' });

  const loadThreads = () => api<{ threads: Thread[] }>('/api/agent/threads').then(r => setThreads(r.threads));
  const loadMcp = () => api<{ servers: McpServer[] }>('/api/agent/mcp-servers').then(r => setMcp(r.servers));

  async function addMcp(e: React.FormEvent) {
    e.preventDefault();
    try {
      const payload: Record<string, unknown> = { name: mcpForm.name, url: mcpForm.url };
      if (mcpForm.authHeader.trim()) payload.authHeader = mcpForm.authHeader.trim();
      await api('/api/agent/mcp-servers', { method: 'POST', body: JSON.stringify(payload) });
      setMcpForm({ name: '', url: '', authHeader: '' });
      loadMcp();
      toast.success('MCP server added');
    } catch (err: unknown) {
      toast.error('Add failed: ' + (err as Error).message);
    }
  }
  async function delMcp(id: string) {
    if (!confirm('Remove this MCP server?')) return;
    try { await api(`/api/agent/mcp-servers/${id}`, { method: 'DELETE' }); loadMcp(); toast.success('Removed'); }
    catch (err: unknown) { toast.error('Remove failed: ' + (err as Error).message); }
  }

  useEffect(() => {
    Promise.all([
      api<{ config: AgentConfig | null }>('/api/agent/config'),
      api<{ threads: Thread[] }>('/api/agent/threads'),
    ]).then(([c, t]) => {
      if (c.config) {
        setCfg(c.config);
        setForm(f => ({ ...f, enabled: c.config!.enabled, model: c.config!.model, systemPrompt: c.config!.system_prompt, autoApproveJobix: c.config!.auto_approve_jobix, maxToolIterations: c.config!.max_tool_iterations, jobixWebhookUrl: c.config!.jobix_webhook_url ?? '' }));
      }
      setThreads(t.threads);
      setLoading(false);
    }).catch(() => setLoading(false));
    loadMcp().catch(() => {});
  }, []);

  async function saveConfig(e: React.FormEvent) {
    e.preventDefault();
    try {
      const payload: Record<string, unknown> = {
        enabled: form.enabled, model: form.model, systemPrompt: form.systemPrompt,
        autoApproveJobix: form.autoApproveJobix, maxToolIterations: form.maxToolIterations,
      };
      if (form.openaiKey.trim()) payload.openaiKey = form.openaiKey.trim();
      if (form.jobixWebhookUrl.trim()) payload.jobixWebhookUrl = form.jobixWebhookUrl.trim();
      if (form.jobixWebhookSecret.trim()) payload.jobixWebhookSecret = form.jobixWebhookSecret.trim();
      const r = await api<{ config: AgentConfig }>('/api/agent/config', { method: 'PUT', body: JSON.stringify(payload) });
      setCfg(r.config);
      setForm(f => ({ ...f, openaiKey: '', jobixWebhookSecret: '' }));
      toast.success('Agent settings saved');
    } catch (err: unknown) {
      toast.error('Save failed: ' + (err as Error).message);
    }
  }

  async function toggleThread(id: string) {
    if (openThread === id) { setOpenThread(null); return; }
    setOpenThread(id);
    if (!messages[id]) {
      const r = await api<{ messages: Msg[] }>(`/api/agent/threads/${id}`);
      setMessages(m => ({ ...m, [id]: r.messages }));
    }
  }

  async function decide(threadId: string, msgId: string, action: 'approve' | 'reject') {
    try {
      await api(`/api/agent/messages/${msgId}/${action}`, { method: 'POST' });
      const r = await api<{ messages: Msg[] }>(`/api/agent/threads/${threadId}`);
      setMessages(m => ({ ...m, [threadId]: r.messages }));
      toast.success(action === 'approve' ? 'Approved' : 'Rejected');
    } catch (err: unknown) {
      toast.error('Failed: ' + (err as Error).message);
    }
  }

  if (loading) {
    return <div className="space-y-6"><PageHeader title="AI responses" /><Skeleton className="h-40" /></div>;
  }

  return (
    <div className="space-y-6">
      <PageHeader title="AI responses" subtitle="An OpenAI agent that responds to Jobix-driven threads. Jobix-sourced replies auto-send; others wait for your approval." />

      <IntegrationExplainer />

      <Card>
        <h2 className="font-heading font-semibold text-ink mb-4">Agent settings</h2>
        <form className="space-y-4 max-w-xl" onSubmit={saveConfig}>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} />
            Enable the agent
          </label>
          <Field label="Model" hint="Any OpenAI model id, e.g. gpt-4o.">
            <Input value={form.model} onChange={e => setForm({ ...form, model: e.target.value })} />
          </Field>
          <Field label="System prompt" hint="Persona / instructions for the agent. Leave blank for a sensible default.">
            <textarea className={`${selectCls} min-h-[100px]`} value={form.systemPrompt} onChange={e => setForm({ ...form, systemPrompt: e.target.value })} />
          </Field>
          <Field label="OpenAI API key" hint={cfg?.has_key ? 'A key is set. Leave blank to keep it, or paste a new one to replace.' : 'Required to run the agent.'}>
            <Input type="password" value={form.openaiKey} placeholder={cfg?.has_key ? '•••••••••• (set)' : 'sk-...'} onChange={e => setForm({ ...form, openaiKey: e.target.value })} />
          </Field>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={form.autoApproveJobix} onChange={e => setForm({ ...form, autoApproveJobix: e.target.checked })} />
            Auto-approve Jobix-sourced responses
          </label>
          <Field label="Jobix webhook URL" hint="Where to POST thread outcomes back to Jobix (agent.response events).">
            <Input value={form.jobixWebhookUrl} placeholder="https://…/jobix-webhook" onChange={e => setForm({ ...form, jobixWebhookUrl: e.target.value })} />
          </Field>
          <Field label="Jobix webhook secret" hint={cfg?.has_webhook_secret ? 'A secret is set (used to HMAC-sign deliveries). Leave blank to keep it.' : 'Used to HMAC-sign deliveries so Jobix can verify them.'}>
            <Input type="password" value={form.jobixWebhookSecret} placeholder={cfg?.has_webhook_secret ? '•••••••••• (set)' : 'whsec_…'} onChange={e => setForm({ ...form, jobixWebhookSecret: e.target.value })} />
          </Field>
          <div className="flex justify-end"><Button type="submit">Save settings</Button></div>
        </form>
      </Card>

      <Card>
        <h2 className="font-heading font-semibold text-ink mb-1">MCP tool servers</h2>
        <p className="text-sm text-ink-dim mb-4">Connect MCP servers and the agent can call their tools while composing a reply. Tools are namespaced per server.</p>
        {mcp.length > 0 && (
          <div className="space-y-2 mb-4">
            {mcp.map(s => (
              <div key={s.id} className="flex items-center gap-3 rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm">
                <span className="font-medium text-ink">{s.name}</span>
                <span className="text-ink-dim font-mono text-xs truncate">{s.url}</span>
                {s.has_auth && <span className="text-xs text-ink-dim">· auth set</span>}
                <span className="ml-auto"><Button variant="danger" onClick={() => delMcp(s.id)}>Remove</Button></span>
              </div>
            ))}
          </div>
        )}
        <form className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end" onSubmit={addMcp}>
          <Field label="Name"><Input required value={mcpForm.name} onChange={e => setMcpForm({ ...mcpForm, name: e.target.value })} placeholder="My tools" /></Field>
          <Field label="Server URL"><Input required value={mcpForm.url} onChange={e => setMcpForm({ ...mcpForm, url: e.target.value })} placeholder="https://…/mcp" /></Field>
          <Field label="Auth header (optional)"><Input type="password" value={mcpForm.authHeader} onChange={e => setMcpForm({ ...mcpForm, authHeader: e.target.value })} placeholder="Bearer …" /></Field>
          <div className="md:col-span-3 flex justify-end"><Button type="submit" variant="secondary">Add MCP server</Button></div>
        </form>
      </Card>

      <div>
        <h2 className="font-heading font-semibold text-ink mb-3">Threads</h2>
        {threads.length === 0 ? (
          <EmptyState icon={Bot} title="No threads yet" description="When Jobix posts to /v1/agent/messages, conversations appear here." />
        ) : (
          <div className="space-y-2">
            {threads.map(t => (
              <Card key={t.id} className="p-0 overflow-hidden">
                <button className="flex items-center gap-2 w-full text-left px-4 py-3" onClick={() => toggleThread(t.id)}>
                  {openThread === t.id ? <ChevronDown size={16} className="text-ink-dim" /> : <ChevronRight size={16} className="text-ink-dim" />}
                  <span className="font-medium text-ink">{t.subject || t.jobix_thread_ref}</span>
                  <span className="text-xs text-ink-dim ml-auto">{new Date(t.updated_at).toLocaleString()}</span>
                </button>
                {openThread === t.id && (
                  <div className="border-t border-line p-4 space-y-3">
                    {(messages[t.id] ?? []).map(m => (
                      <div key={m.id} className={`rounded-xl p-3 text-sm ${m.role === 'agent' ? 'bg-magenta/10 border border-magenta/20' : 'bg-surface-raised border border-line'}`}>
                        <div className="flex items-center gap-2 mb-1 text-xs text-ink-dim">
                          <span className="uppercase tracking-wide">{m.role}</span>
                          <span>· {m.source}</span>
                          <span className="ml-auto"><StatusBadge status={m.status} /></span>
                        </div>
                        <div className="text-ink-muted whitespace-pre-wrap">{m.content}</div>
                        {m.role === 'agent' && m.status === 'pending_approval' && (
                          <div className="flex justify-end gap-2 mt-3">
                            <Button variant="ghost" onClick={() => decide(t.id, m.id, 'reject')}>Reject</Button>
                            <Button onClick={() => decide(t.id, m.id, 'approve')}>Approve</Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
