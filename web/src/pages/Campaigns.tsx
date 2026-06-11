import { useEffect, useState } from 'react';
import { Megaphone } from 'lucide-react';
import { api } from '@aiployee/ui';
import { Table, Th, Td } from '@aiployee/ui';
import { Button } from '@aiployee/ui';
import { Input, Field } from '@aiployee/ui';
import { Card } from '@aiployee/ui';
import { Modal } from '@aiployee/ui';
import { PageHeader } from '@aiployee/ui';
import { EmptyState } from '@aiployee/ui';
import { Skeleton } from '@aiployee/ui';
import { StatusBadge } from '@aiployee/ui';
import { useToast } from '@aiployee/ui';

interface Campaign { id: string; name: string; status: string; audience_type: string; audience_id: string; scheduled_for: string | null; created_at: string }
interface Sender { id: string; email: string; display_name: string }
interface NamedRow { id: string; name: string }
interface Stats { recipients: number; sent: number; opens: number; clicks: number; bounced: number; replies: number; repliers: number }
interface Reply { id: string; from_addr: string; from_name: string | null; subject: string | null; snippet: string | null; received_at: string }

const selectCls = 'w-full rounded-lg border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent';
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

export default function Campaigns() {
  const toast = useToast();
  const [items, setItems] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [lists, setLists] = useState<NamedRow[]>([]);
  const [segments, setSegments] = useState<NamedRow[]>([]);
  const [report, setReport] = useState<{ campaign: Campaign; stats: Stats; replies: Reply[] } | null>(null);
  const [form, setForm] = useState({ name: '', senderId: '', subject: '', bodyHtml: '', audienceType: 'list', audienceId: '', scheduledFor: '' });

  const load = () => { setLoading(true); api<{ campaigns: Campaign[] }>('/api/campaigns').then(r => { setItems(r.campaigns); setLoading(false); }); };
  useEffect(() => {
    load();
    api<{ senders: Sender[] }>('/api/senders').then(r => { setSenders(r.senders); if (r.senders[0]) setForm(f => ({ ...f, senderId: r.senders[0].id })); }).catch(() => {});
    api<{ lists: NamedRow[] }>('/api/lists').then(r => setLists(r.lists)).catch(() => {});
    api<{ segments: NamedRow[] }>('/api/segments').then(r => setSegments(r.segments)).catch(() => {});
  }, []);

  const audienceOptions = form.audienceType === 'list' ? lists : segments;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!form.audienceId) { toast.error('Pick an audience'); return; }
    try {
      const payload: Record<string, unknown> = {
        name: form.name, senderId: form.senderId, subject: form.subject, bodyHtml: form.bodyHtml,
        audienceType: form.audienceType, audienceId: form.audienceId,
      };
      if (form.scheduledFor) payload.scheduledFor = new Date(form.scheduledFor).toISOString();
      await api('/api/campaigns', { method: 'POST', body: JSON.stringify(payload) });
      setForm(f => ({ ...f, name: '', subject: '', bodyHtml: '', audienceId: '', scheduledFor: '' }));
      load(); toast.success('Campaign created (draft)');
    } catch (err: unknown) { toast.error('Create failed: ' + (err as Error).message); }
  }
  async function send(c: Campaign) {
    if (!confirm(`Send campaign "${c.name}" now? Recipients are queued and dripped out via the send worker.`)) return;
    try { const r = await api<{ queued: number; skipped: number }>(`/api/campaigns/${c.id}/send`, { method: 'POST' }); toast.success(`Queued ${r.queued} (skipped ${r.skipped})`); load(); }
    catch (err: unknown) { toast.error('Send failed: ' + (err as Error).message); }
  }
  async function cancel(c: Campaign) {
    if (!confirm(`Cancel "${c.name}"? Unsent queued emails will be canceled.`)) return;
    try { await api(`/api/campaigns/${c.id}/cancel`, { method: 'POST' }); toast.success('Canceled'); load(); }
    catch (err: unknown) { toast.error((err as Error).message); }
  }
  async function del(c: Campaign) {
    if (!confirm(`Delete "${c.name}"?`)) return;
    try { await api(`/api/campaigns/${c.id}`, { method: 'DELETE' }); load(); toast.success('Deleted'); }
    catch (err: unknown) { toast.error((err as Error).message); }
  }
  async function openReport(c: Campaign) {
    const r = await api<{ campaign: Campaign; stats: Stats; replies: Reply[] }>(`/api/campaigns/${c.id}`);
    setReport(r);
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Campaigns" subtitle="Send a one-off email to a list or segment. Recipients are queued and dripped through your SMTP; unsubscribed/suppressed contacts are skipped." />

      <Card>
        <h2 className="font-heading font-semibold text-ink mb-4">New campaign</h2>
        <form className="space-y-4" onSubmit={create}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Name"><Input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="May newsletter" /></Field>
            <Field label="From (sender)">
              <select className={selectCls} value={form.senderId} onChange={e => setForm({ ...form, senderId: e.target.value })}>
                {senders.map(s => <option key={s.id} value={s.id}>{s.display_name} — {s.email}</option>)}
              </select>
            </Field>
            <Field label="Audience type">
              <select className={selectCls} value={form.audienceType} onChange={e => setForm({ ...form, audienceType: e.target.value, audienceId: '' })}>
                <option value="list">List</option>
                <option value="segment">Segment</option>
              </select>
            </Field>
            <Field label={form.audienceType === 'list' ? 'List' : 'Segment'}>
              <select className={selectCls} value={form.audienceId} onChange={e => setForm({ ...form, audienceId: e.target.value })}>
                <option value="">Select…</option>
                {audienceOptions.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Subject"><Input required value={form.subject} onChange={e => setForm({ ...form, subject: e.target.value })} placeholder="Hi {{name}} — what's new" /></Field>
          <Field label="Body (HTML)" hint="Use {{name}}, {{email}}, or any contact attribute as a placeholder. An unsubscribe link is added automatically.">
            <textarea required className={`${selectCls} min-h-[140px] font-mono`} value={form.bodyHtml} onChange={e => setForm({ ...form, bodyHtml: e.target.value })} placeholder="<p>Hello {{name}},</p>" />
          </Field>
          <Field label="Schedule (optional)" hint="Leave blank to send as soon as you click Send.">
            <Input type="datetime-local" value={form.scheduledFor} onChange={e => setForm({ ...form, scheduledFor: e.target.value })} />
          </Field>
          <div className="flex justify-end"><Button type="submit">Create draft</Button></div>
        </form>
      </Card>

      {loading ? (
        <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-9" />)}</div>
      ) : items.length === 0 ? (
        <EmptyState icon={Megaphone} title="No campaigns yet" description="Create a draft above, then send it to a list or segment." />
      ) : (
        <Table>
          <thead><tr><Th>Name</Th><Th>Status</Th><Th>Audience</Th><Th>Created</Th><Th>{''}</Th></tr></thead>
          <tbody>{items.map(c => (
            <tr key={c.id}>
              <Td className="text-ink">{c.name}</Td>
              <Td><StatusBadge status={c.status} /></Td>
              <Td className="text-ink-dim">{c.audience_type}</Td>
              <Td className="text-ink-dim">{new Date(c.created_at).toLocaleDateString()}</Td>
              <Td>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => openReport(c)}>Report</Button>
                  {(c.status === 'draft' || c.status === 'scheduled') && <Button onClick={() => send(c)}>Send</Button>}
                  {(c.status === 'sending' || c.status === 'scheduled') && <Button variant="ghost" onClick={() => cancel(c)}>Cancel</Button>}
                  <Button variant="danger" onClick={() => del(c)}>Delete</Button>
                </div>
              </Td>
            </tr>
          ))}</tbody>
        </Table>
      )}

      <Modal open={!!report} onClose={() => setReport(null)} title={report ? `Report — ${report.campaign.name}` : ''}>
        {report && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              {[
                ['Recipients', report.stats.recipients, 'text-ink'],
                ['Delivered', report.stats.sent, 'text-success'],
                ['Opens', `${report.stats.opens} (${pct(report.stats.opens, report.stats.sent)}%)`, 'text-magenta'],
                ['Clicks', `${report.stats.clicks} (${pct(report.stats.clicks, report.stats.sent)}%)`, 'text-accent'],
                ['Bounced', report.stats.bounced, 'text-error'],
                ['Replies', `${report.stats.replies} (${pct(report.stats.repliers, report.stats.sent)}%)`, 'text-success'],
              ].map(([label, val, color]) => (
                <div key={label as string} className="bg-surface-raised border border-line rounded-xl p-3">
                  <div className="text-xs uppercase tracking-wide text-ink-dim">{label}</div>
                  <div className={`text-2xl font-semibold mt-1 ${color}`}>{val}</div>
                </div>
              ))}
            </div>
            {report.replies.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-wide text-ink-dim mb-2">
                  Latest replies — {report.stats.repliers} {report.stats.repliers === 1 ? 'person' : 'people'} replied
                </div>
                <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
                  {report.replies.map(r => (
                    <div key={r.id} className="bg-surface-raised border border-line rounded-xl p-3 text-sm">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-medium text-ink truncate">{r.from_name || r.from_addr}</span>
                        <span className="text-xs text-ink-dim shrink-0">{new Date(r.received_at).toLocaleString()}</span>
                      </div>
                      {r.subject && <div className="text-ink-muted truncate">{r.subject}</div>}
                      {r.snippet && <p className="text-xs text-ink-dim mt-1 line-clamp-2">{r.snippet}</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
