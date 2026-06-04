import { useEffect, useMemo, useState } from 'react';
import { FileText } from 'lucide-react';
import { api } from '../api';
import { Table, Th, Td } from '../components/Table';
import { Button } from '../components/Button';
import { Input, Field } from '../components/Input';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';
import { useToast } from '../components/Toast';
import { useAuth } from '../auth';
import { testSendTemplate } from '../lib/templates';

interface Tpl { id: string; name: string; subject: string; display_name: string | null; body_html: string; body_text: string | null; variables: string[] }

const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
function vars(s: string): string[] { return [...new Set([...s.matchAll(VAR_RE)].map(m => m[1]))]; }
function render(s: string, v: Record<string, string>): string {
  return s.replace(VAR_RE, (_m, n) => v[n] ?? `{{${n}}}`);
}

export default function Templates() {
  const [items, setItems] = useState<Tpl[]>([]);
  const [sel, setSel] = useState<Tpl | null>(null);
  const [loading, setLoading] = useState(true);
  const toast = useToast();
  const { user } = useAuth();
  const refresh = () => api<{ templates: Tpl[] }>('/api/templates').then(r => { setItems(r.templates); setLoading(false); });
  useEffect(() => { refresh(); }, []);

  const allVars = useMemo(() => sel ? [...new Set([...vars(sel.subject), ...vars(sel.body_html), ...vars(sel.body_text ?? '')])] : [], [sel]);
  const [scratch, setScratch] = useState<Record<string, string>>({});

  // Send-test panel state
  const [testOpen, setTestOpen] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testVars, setTestVars] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [recipientError, setRecipientError] = useState<string | null>(null);

  function openTestPanel() {
    setTestTo(user?.email ?? '');
    setTestVars(Object.fromEntries(allVars.map(v => [v, v])));
    setTestError(null);
    setRecipientError(null);
    setTestOpen(true);
  }

  async function sendTest() {
    if (!sel) return;
    const to = testTo.trim();
    if (!to) { setRecipientError('Recipient email is required.'); return; }
    setRecipientError(null);
    setSending(true);
    try {
      const res = await testSendTemplate(sel.id, { to, variables: testVars });
      if (res.ok) {
        setTestError(null);
        toast.success(`Test sent to ${to}`);
      } else {
        setTestError(res.error ?? 'Send failed (no error detail returned).');
        toast.error('Test send failed');
      }
    } catch (e) {
      setTestError((e as Error).message ?? String(e));
      toast.error('Test send failed');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Templates"
        subtitle="Email templates with variable substitution."
        actions={
          <Button onClick={async () => {
            const name = prompt('Name (a-z, 0-9, _, -):'); if (!name) return;
            try {
              await api('/api/templates', { method: 'POST', body: JSON.stringify({ name, subject: 'Subject', bodyHtml: '<p>Hello {{name}}</p>' }) });
              toast.success('Saved');
              refresh();
            } catch (e) {
              toast.error((e as Error).message);
            }
          }}>New template</Button>
        }
      />
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={FileText} title="No templates yet" />
      ) : (
        <div className="grid grid-cols-[280px_1fr] gap-6">
          <Table>
            <thead><tr><Th>Name</Th></tr></thead>
            <tbody>{items.map(t => (
              <tr key={t.id} className={`cursor-pointer ${sel?.id === t.id ? 'bg-surface-raised' : ''}`} onClick={() => { setSel(t); setScratch({}); setTestOpen(false); setTestError(null); setRecipientError(null); }}>
                <Td>{t.name}</Td>
              </tr>
            ))}</tbody>
          </Table>
          {sel && (
            <div className="space-y-4">
              <Field label="Subject"><Input value={sel.subject} onChange={e => setSel({ ...sel, subject: e.target.value })} /></Field>
              <Field label="From display name" hint="Overrides the sender's name when this template is used. Leave blank to use the sender's name.">
                <Input value={sel.display_name ?? ''} onChange={e => setSel({ ...sel, display_name: e.target.value })} />
              </Field>
              <Field label="HTML body">
                <textarea className="w-full h-40 rounded-md border border-line bg-surface p-3 text-sm font-mono text-ink"
                          value={sel.body_html} onChange={e => setSel({ ...sel, body_html: e.target.value })} />
              </Field>
              <Field label="Text fallback (optional)">
                <textarea className="w-full h-24 rounded-md border border-line bg-surface p-3 text-sm font-mono text-ink"
                          value={sel.body_text ?? ''} onChange={e => setSel({ ...sel, body_text: e.target.value })} />
              </Field>
              <div className="bg-surface border border-line rounded-2xl p-4 space-y-2">
                <div className="text-sm font-medium text-ink mb-2">Variables</div>
                <div className="grid grid-cols-2 gap-2">
                  {allVars.map(v => (
                    <Field key={v} label={v}>
                      <Input value={scratch[v] ?? ''} onChange={e => setScratch({ ...scratch, [v]: e.target.value })} />
                    </Field>
                  ))}
                  {allVars.length === 0 && <div className="text-sm text-ink-dim">None detected.</div>}
                </div>
              </div>
              <div className="bg-surface border border-line rounded-2xl overflow-hidden">
                <div className="text-sm font-medium text-ink px-4 py-3 border-b border-line">Preview</div>
                <div className="px-3 py-2 border-b border-line text-sm text-ink bg-surface-raised">{render(sel.subject, scratch)}</div>
                <iframe className="w-full h-64 bg-surface" srcDoc={render(sel.body_html, scratch)} />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" aria-expanded={testOpen} onClick={() => testOpen ? setTestOpen(false) : openTestPanel()}>
                  Send test
                </Button>
                <Button variant="danger" onClick={async () => {
                  if (!confirm(`Delete ${sel.name}?`)) return;
                  try {
                    await api(`/api/templates/${sel.id}`, { method: 'DELETE' });
                    toast.success('Deleted');
                    setSel(null); refresh();
                  } catch (e) {
                    toast.error((e as Error).message);
                  }
                }}>Delete</Button>
                <Button onClick={async () => {
                  try {
                    await api(`/api/templates/${sel.id}`, { method: 'PATCH', body: JSON.stringify({
                      subject: sel.subject, displayName: (sel.display_name ?? '').trim() || null, bodyHtml: sel.body_html, bodyText: sel.body_text ?? null,
                    }) });
                    toast.success('Saved');
                    refresh();
                  } catch (e) {
                    toast.error((e as Error).message);
                  }
                }}>Save</Button>
              </div>
              {testOpen && (
                <div className="bg-surface border border-line rounded-2xl p-4 space-y-4">
                  <div className="text-sm font-medium text-ink">Send test</div>
                  <Field label="Recipient">
                    <Input
                      type="email"
                      value={testTo}
                      onChange={e => { setTestTo(e.target.value); if (recipientError) setRecipientError(null); }}
                      placeholder="you@example.com"
                      aria-invalid={!!recipientError}
                    />
                  </Field>
                  {recipientError && <div className="text-sm text-error">{recipientError}</div>}
                  {allVars.length > 0 && (
                    <div className="grid grid-cols-2 gap-2">
                      {allVars.map(v => (
                        <Field key={v} label={v}>
                          <Input value={testVars[v] ?? ''} onChange={e => setTestVars({ ...testVars, [v]: e.target.value })} />
                        </Field>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center gap-3">
                    <Button onClick={sendTest} disabled={sending}>{sending ? 'Sending test…' : 'Send'}</Button>
                    {sending && <span className="text-sm text-ink-dim">Sending test…</span>}
                  </div>
                  {testError && (
                    <pre className="text-xs font-mono text-error bg-surface-raised border border-error/40 rounded-lg p-3 whitespace-pre-wrap break-words max-h-48 overflow-auto" role="alert">
                      {testError}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
