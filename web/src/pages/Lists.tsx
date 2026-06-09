import { useEffect, useState } from 'react';
import { ListChecks } from 'lucide-react';
import { api } from '@aiployee/ui';
import { Table, Th, Td } from '@aiployee/ui';
import { Button } from '@aiployee/ui';
import { Input, Field } from '@aiployee/ui';
import { Card } from '@aiployee/ui';
import { Modal } from '@aiployee/ui';
import { PageHeader } from '@aiployee/ui';
import { EmptyState } from '@aiployee/ui';
import { Skeleton } from '@aiployee/ui';
import { useToast } from '@aiployee/ui';

interface List { id: string; name: string; member_count: number; created_at: string }
interface Contact { id: string; email: string; name: string | null }

export default function Lists() {
  const toast = useToast();
  const [lists, setLists] = useState<List[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [manage, setManage] = useState<List | null>(null);
  const [members, setMembers] = useState<Contact[]>([]);
  const [allContacts, setAllContacts] = useState<Contact[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const load = () => { setLoading(true); api<{ lists: List[] }>('/api/lists').then(r => { setLists(r.lists); setLoading(false); }); };
  useEffect(() => { load(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try { await api('/api/lists', { method: 'POST', body: JSON.stringify({ name }) }); setName(''); load(); toast.success('List created'); }
    catch (err: unknown) { toast.error((err as Error).message); }
  }
  async function del(l: List) {
    if (!confirm(`Delete list "${l.name}"?`)) return;
    try { await api(`/api/lists/${l.id}`, { method: 'DELETE' }); load(); toast.success('Deleted'); }
    catch (err: unknown) { toast.error((err as Error).message); }
  }
  async function openManage(l: List) {
    setManage(l); setPicked(new Set());
    const [m, c] = await Promise.all([
      api<{ members: Contact[] }>(`/api/lists/${l.id}/members`),
      api<{ contacts: Contact[] }>('/api/contacts?limit=1000'),
    ]);
    setMembers(m.members); setAllContacts(c.contacts);
  }
  async function refreshMembers(listId: string) {
    const m = await api<{ members: Contact[] }>(`/api/lists/${listId}/members`);
    setMembers(m.members); load();
  }
  async function addPicked() {
    if (!manage || !picked.size) return;
    try { await api(`/api/lists/${manage.id}/members`, { method: 'POST', body: JSON.stringify({ contactIds: [...picked] }) }); setPicked(new Set()); refreshMembers(manage.id); toast.success('Added'); }
    catch (err: unknown) { toast.error((err as Error).message); }
  }
  async function removeMember(contactId: string) {
    if (!manage) return;
    try { await api(`/api/lists/${manage.id}/members/${contactId}`, { method: 'DELETE' }); refreshMembers(manage.id); }
    catch (err: unknown) { toast.error((err as Error).message); }
  }

  const memberIds = new Set(members.map(m => m.id));
  const candidates = allContacts.filter(c => !memberIds.has(c.id));

  return (
    <div className="space-y-6">
      <PageHeader title="Lists" subtitle="Static audiences you manage by hand. (Rule-based segments come next.)" />

      <Card>
        <form className="flex items-end gap-3" onSubmit={create}>
          <Field label="New list name"><Input required value={name} onChange={e => setName(e.target.value)} placeholder="Newsletter subscribers" /></Field>
          <Button type="submit">Create list</Button>
        </form>
      </Card>

      {loading ? (
        <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-9" />)}</div>
      ) : lists.length === 0 ? (
        <EmptyState icon={ListChecks} title="No lists yet" description="Create a list, then add contacts to it." />
      ) : (
        <Table>
          <thead><tr><Th>Name</Th><Th>Members</Th><Th>Created</Th><Th>{''}</Th></tr></thead>
          <tbody>{lists.map(l => (
            <tr key={l.id}>
              <Td className="text-ink">{l.name}</Td>
              <Td>{l.member_count}</Td>
              <Td className="text-ink-dim">{new Date(l.created_at).toLocaleDateString()}</Td>
              <Td>
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onClick={() => openManage(l)}>Manage</Button>
                  <Button variant="danger" onClick={() => del(l)}>Delete</Button>
                </div>
              </Td>
            </tr>
          ))}</tbody>
        </Table>
      )}

      <Modal open={!!manage} onClose={() => setManage(null)} title={manage ? `Manage "${manage.name}"` : ''}>
        {manage && (
          <div className="space-y-4">
            <div>
              <div className="text-xs uppercase tracking-wide text-ink-dim mb-2">Members ({members.length})</div>
              {members.length === 0 ? <p className="text-sm text-ink-dim">No members yet.</p> : (
                <div className="space-y-1 max-h-40 overflow-auto">
                  {members.map(m => (
                    <div key={m.id} className="flex items-center gap-2 text-sm">
                      <span className="text-ink">{m.email}</span>
                      <button onClick={() => removeMember(m.id)} className="ml-auto text-xs text-error hover:underline">remove</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-ink-dim mb-2">Add contacts</div>
              {candidates.length === 0 ? <p className="text-sm text-ink-dim">All contacts are already in this list.</p> : (
                <div className="space-y-1 max-h-48 overflow-auto border border-line rounded-lg p-2">
                  {candidates.map(c => (
                    <label key={c.id} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input type="checkbox" checked={picked.has(c.id)} onChange={e => {
                        setPicked(prev => { const n = new Set(prev); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; });
                      }} />
                      <span className="text-ink-muted">{c.email}</span>
                    </label>
                  ))}
                </div>
              )}
              <div className="flex justify-end mt-3">
                <Button disabled={!picked.size} onClick={addPicked}>Add {picked.size || ''} selected</Button>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
