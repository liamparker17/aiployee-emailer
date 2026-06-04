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
  const refresh = () => api<{ templates: Tpl[] }>('/api/templates').then(r => { setItems(r.templates); setLoading(false); });
  useEffect(() => { refresh(); }, []);

  const allVars = useMemo(() => sel ? [...new Set([...vars(sel.subject), ...vars(sel.body_html), ...vars(sel.body_text ?? '')])] : [], [sel]);
  const [scratch, setScratch] = useState<Record<string, string>>({});

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
              <tr key={t.id} className={`cursor-pointer ${sel?.id === t.id ? 'bg-surface-raised' : ''}`} onClick={() => { setSel(t); setScratch({}); }}>
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
            </div>
          )}
        </div>
      )}
    </div>
  );
}
