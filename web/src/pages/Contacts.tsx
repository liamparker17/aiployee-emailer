import { useEffect, useRef, useState } from 'react';
import { Users as UsersIcon } from 'lucide-react';
import { api } from '../api';
import { Table, Th, Td } from '../components/Table';
import { Button } from '../components/Button';
import { Input, Field } from '../components/Input';
import { Card } from '../components/Card';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';
import { StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';

interface Contact { id: string; email: string; name: string | null; subscribed: boolean; attributes: Record<string, unknown>; created_at: string }

// Minimal CSV parser (handles quoted fields). First row = headers; `email`/`name`
// are recognised, all other columns become custom attributes.
function parseCsv(text: string): Array<{ email: string; name?: string; attributes: Record<string, string> }> {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const parseLine = (line: string): string[] => {
    const out: string[] = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur); return out;
  };
  const headers = parseLine(lines[0]).map(h => h.trim().toLowerCase());
  return lines.slice(1).map(line => {
    const cells = parseLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = (cells[i] ?? '').trim(); });
    const { email, name, ...rest } = row;
    return { email, name: name || undefined, attributes: rest };
  }).filter(r => r.email && r.email.includes('@'));
}

export default function Contacts() {
  const toast = useToast();
  const [items, setItems] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({ email: '', name: '' });
  const fileRef = useRef<HTMLInputElement>(null);

  const load = (q = search) => {
    setLoading(true);
    const qs = q ? `?search=${encodeURIComponent(q)}` : '';
    api<{ contacts: Contact[] }>(`/api/contacts${qs}`).then(r => { setItems(r.contacts); setLoading(false); });
  };
  useEffect(() => { load(''); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function addContact(e: React.FormEvent) {
    e.preventDefault();
    try { await api('/api/contacts', { method: 'POST', body: JSON.stringify({ email: form.email, name: form.name || undefined }) }); setForm({ email: '', name: '' }); load(); toast.success('Contact added'); }
    catch (err: unknown) { toast.error('Add failed: ' + (err as Error).message); }
  }
  async function toggleSub(c: Contact) {
    try { await api(`/api/contacts/${c.id}`, { method: 'PATCH', body: JSON.stringify({ subscribed: !c.subscribed }) }); load(); }
    catch (err: unknown) { toast.error((err as Error).message); }
  }
  async function del(c: Contact) {
    if (!confirm(`Delete ${c.email}?`)) return;
    try { await api(`/api/contacts/${c.id}`, { method: 'DELETE' }); load(); toast.success('Deleted'); }
    catch (err: unknown) { toast.error((err as Error).message); }
  }
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    const text = await file.text();
    const contacts = parseCsv(text);
    if (!contacts.length) { toast.error('No valid rows found (need an "email" column)'); return; }
    try {
      const r = await api<{ imported: number }>('/api/contacts/import', { method: 'POST', body: JSON.stringify({ contacts }) });
      toast.success(`Imported ${r.imported} contacts`); load();
    } catch (err: unknown) { toast.error('Import failed: ' + (err as Error).message); }
    if (fileRef.current) fileRef.current.value = '';
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Contacts" subtitle="Your marketing audience. Import a CSV (with an email column; extra columns become custom attributes)."
        actions={<>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} />
          <Button variant="secondary" onClick={() => fileRef.current?.click()}>Import CSV</Button>
        </>} />

      <Card>
        <form className="flex flex-wrap items-end gap-3" onSubmit={addContact}>
          <Field label="Email"><Input type="email" required value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="jane@example.com" /></Field>
          <Field label="Name"><Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Jane Doe" /></Field>
          <Button type="submit">Add contact</Button>
        </form>
      </Card>

      <div className="flex gap-2">
        <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search email or name…"
          onKeyDown={e => { if (e.key === 'Enter') load(); }} />
        <Button variant="secondary" onClick={() => load()}>Search</Button>
      </div>

      {loading ? (
        <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-9" />)}</div>
      ) : items.length === 0 ? (
        <EmptyState icon={UsersIcon} title="No contacts yet" description="Add a contact above or import a CSV." />
      ) : (
        <Table>
          <thead><tr><Th>Email</Th><Th>Name</Th><Th>Status</Th><Th>Attributes</Th><Th>{''}</Th></tr></thead>
          <tbody>{items.map(c => (
            <tr key={c.id}>
              <Td className="text-ink">{c.email}</Td>
              <Td>{c.name || '—'}</Td>
              <Td><StatusBadge status={c.subscribed ? 'subscribed' : 'unsubscribed'} /></Td>
              <Td className="text-ink-dim">{Object.keys(c.attributes || {}).length || '—'}</Td>
              <Td>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => toggleSub(c)}>{c.subscribed ? 'Unsubscribe' : 'Resubscribe'}</Button>
                  <Button variant="danger" onClick={() => del(c)}>Delete</Button>
                </div>
              </Td>
            </tr>
          ))}</tbody>
        </Table>
      )}
    </div>
  );
}
