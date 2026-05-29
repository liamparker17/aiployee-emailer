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
}
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
          <p className="text-xs text-ink-dim">Full contract: <code className="font-mono">docs/agent-jobix-integration.md</code>. Outbound webhooks to Jobix land in Phase 2.</p>
        </div>
      )}
    </Card>
  );
}

export default function AiResponses() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [cfg, setCfg] = useState<AgentConfig | null>(null);
  const [form, setForm] = useState({ enabled: false, model: 'gpt-4o', systemPrompt: '', autoApproveJobix: true, maxToolIterations: 4, openaiKey: '' });
  const [threads, setThreads] = useState<Thread[]>([]);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, Msg[]>>({});

  const loadThreads = () => api<{ threads: Thread[] }>('/api/agent/threads').then(r => setThreads(r.threads));

  useEffect(() => {
    Promise.all([
      api<{ config: AgentConfig | null }>('/api/agent/config'),
      api<{ threads: Thread[] }>('/api/agent/threads'),
    ]).then(([c, t]) => {
      if (c.config) {
        setCfg(c.config);
        setForm(f => ({ ...f, enabled: c.config!.enabled, model: c.config!.model, systemPrompt: c.config!.system_prompt, autoApproveJobix: c.config!.auto_approve_jobix, maxToolIterations: c.config!.max_tool_iterations }));
      }
      setThreads(t.threads);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  async function saveConfig(e: React.FormEvent) {
    e.preventDefault();
    try {
      const payload: Record<string, unknown> = {
        enabled: form.enabled, model: form.model, systemPrompt: form.systemPrompt,
        autoApproveJobix: form.autoApproveJobix, maxToolIterations: form.maxToolIterations,
      };
      if (form.openaiKey.trim()) payload.openaiKey = form.openaiKey.trim();
      const r = await api<{ config: AgentConfig }>('/api/agent/config', { method: 'PUT', body: JSON.stringify(payload) });
      setCfg(r.config);
      setForm(f => ({ ...f, openaiKey: '' }));
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
          <div className="flex justify-end"><Button type="submit">Save settings</Button></div>
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
