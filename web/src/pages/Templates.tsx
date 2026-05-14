import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Table, Th, Td } from '../components/Table';
import { Button } from '../components/Button';
import { Input, Field } from '../components/Input';

interface Tpl { id: string; name: string; subject: string; body_html: string; body_text: string | null; variables: string[] }

const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
function vars(s: string): string[] { return [...new Set([...s.matchAll(VAR_RE)].map(m => m[1]))]; }
function render(s: string, v: Record<string, string>): string {
  return s.replace(VAR_RE, (_m, n) => v[n] ?? `{{${n}}}`);
}

export default function Templates() {
  const [items, setItems] = useState<Tpl[]>([]);
  const [sel, setSel] = useState<Tpl | null>(null);
  const refresh = () => api<{ templates: Tpl[] }>('/api/templates').then(r => setItems(r.templates));
  useEffect(() => { refresh(); }, []);

  const allVars = useMemo(() => sel ? [...new Set([...vars(sel.subject), ...vars(sel.body_html), ...vars(sel.body_text ?? '')])] : [], [sel]);
  const [scratch, setScratch] = useState<Record<string, string>>({});

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-heading font-semibold">Templates</h1>
        <Button onClick={async () => {
          const name = prompt('Name (a-z, 0-9, _, -):'); if (!name) return;
          await api('/api/templates', { method: 'POST', body: JSON.stringify({ name, subject: 'Subject', bodyHtml: '<p>Hello {{name}}</p>' }) });
          refresh();
        }}>New template</Button>
      </div>
      <div className="grid grid-cols-[280px_1fr] gap-6">
        <Table>
          <thead><tr><Th>Name</Th></tr></thead>
          <tbody>{items.map(t => (
            <tr key={t.id} className={`cursor-pointer ${sel?.id === t.id ? 'bg-surface' : ''}`} onClick={() => { setSel(t); setScratch({}); }}>
              <Td>{t.name}</Td>
            </tr>
          ))}</tbody>
        </Table>
        {sel && (
          <div className="space-y-4">
            <Field label="Subject"><Input value={sel.subject} onChange={e => setSel({ ...sel, subject: e.target.value })} /></Field>
            <Field label="HTML body">
              <textarea className="w-full h-40 rounded-md border border-line bg-bg p-3 text-sm font-mono"
                        value={sel.body_html} onChange={e => setSel({ ...sel, body_html: e.target.value })} />
            </Field>
            <Field label="Text fallback (optional)">
              <textarea className="w-full h-24 rounded-md border border-line bg-bg p-3 text-sm font-mono"
                        value={sel.body_text ?? ''} onChange={e => setSel({ ...sel, body_text: e.target.value })} />
            </Field>
            <div>
              <div className="text-sm font-medium mb-2">Variables</div>
              <div className="grid grid-cols-2 gap-2">
                {allVars.map(v => (
                  <Field key={v} label={v}>
                    <Input value={scratch[v] ?? ''} onChange={e => setScratch({ ...scratch, [v]: e.target.value })} />
                  </Field>
                ))}
                {allVars.length === 0 && <div className="text-sm text-muted">None detected.</div>}
              </div>
            </div>
            <div>
              <div className="text-sm font-medium mb-2">Preview</div>
              <div className="border border-line rounded-md">
                <div className="px-3 py-2 border-b border-line text-sm bg-surface">{render(sel.subject, scratch)}</div>
                <iframe className="w-full h-64 bg-bg" srcDoc={render(sel.body_html, scratch)} />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="danger" onClick={async () => {
                if (!confirm(`Delete ${sel.name}?`)) return;
                await api(`/api/templates/${sel.id}`, { method: 'DELETE' });
                setSel(null); refresh();
              }}>Delete</Button>
              <Button onClick={async () => {
                await api(`/api/templates/${sel.id}`, { method: 'PATCH', body: JSON.stringify({
                  subject: sel.subject, bodyHtml: sel.body_html, bodyText: sel.body_text ?? null,
                }) });
                refresh();
              }}>Save</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
