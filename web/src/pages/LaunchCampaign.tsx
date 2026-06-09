import { useEffect, useRef, useState } from 'react';
import { Rocket } from 'lucide-react';
import { api } from '@aiployee/ui';
import { Button } from '@aiployee/ui';
import { Input, Field } from '@aiployee/ui';
import { Card } from '@aiployee/ui';
import { PageHeader } from '@aiployee/ui';
import { useToast } from '@aiployee/ui';

interface Sender { id: string; email: string; display_name: string }
type Row = { email: string; name?: string; attributes: Record<string, string> };
type Attachment = { filename: string; content: string; content_type?: string };

const selectCls = 'w-full rounded-lg border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent';

// Total base64 budget for all attachments — must stay under the server cap (~3 MB)
// and Vercel's ~4.5 MB request-body limit.
const MAX_ATTACH_BYTES = 3 * 1024 * 1024;

// Read a File into base64 (no data-URL prefix), matching the API's attachment shape.
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

function parseCsv(text: string): Row[] {
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

export default function LaunchCampaign() {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const attachRef = useRef<HTMLInputElement>(null);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [fileName, setFileName] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', listName: '', senderId: '', subject: '', bodyHtml: '', scheduledFor: '' });

  useEffect(() => {
    api<{ senders: Sender[] }>('/api/senders').then(r => { setSenders(r.senders); if (r.senders[0]) setForm(f => ({ ...f, senderId: r.senders[0].id })); }).catch(() => {});
  }, []);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    const parsed = parseCsv(await file.text());
    if (!parsed.length) { toast.error('No valid rows (need an "email" column)'); return; }
    setRows(parsed); setFileName(file.name);
    toast.success(`${parsed.length} recipients loaded from ${file.name}`);
  }

  async function onAttach(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (e.target) e.target.value = ''; // allow re-selecting the same file
    if (!files.length) return;
    const next: Attachment[] = [...attachments];
    for (const file of files) {
      if (next.some(a => a.filename === file.name)) continue; // de-dupe by name
      next.push({ filename: file.name, content: await fileToBase64(file), content_type: file.type || undefined });
    }
    const totalBytes = next.reduce((n, a) => n + a.content.length, 0);
    if (totalBytes > MAX_ATTACH_BYTES) {
      toast.error('Attachments are too large — keep the total under ~3 MB.');
      return;
    }
    setAttachments(next);
  }

  function removeAttachment(name: string) {
    setAttachments(a => a.filter(x => x.filename !== name));
  }

  async function launch(e: React.FormEvent) {
    e.preventDefault();
    if (!rows.length) { toast.error('Upload a recipients CSV first'); return; }
    if (!form.senderId) { toast.error('Pick a sender'); return; }
    if (rows.length > 450 && !confirm(`This list has ${rows.length} recipients. Sends go through your own SMTP, which usually caps daily volume (e.g. Gmail/Workspace ≈ 500/day) — recipients beyond the cap will stay queued and retry over the following days. Launch anyway?`)) return;
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name, listName: form.listName || undefined, senderId: form.senderId,
        subject: form.subject, bodyHtml: form.bodyHtml, contacts: rows,
      };
      if (form.scheduledFor) payload.scheduledFor = new Date(form.scheduledFor).toISOString();
      if (attachments.length) payload.attachments = attachments;
      const r = await api<{ imported: number; queued: number; skipped: number }>('/api/campaigns/launch', { method: 'POST', body: JSON.stringify(payload) });
      toast.success(`Launched: imported ${r.imported}, queued ${r.queued}, skipped ${r.skipped}`);
      setRows([]); setFileName(''); setAttachments([]);
      setForm(f => ({ ...f, name: '', listName: '', subject: '', bodyHtml: '', scheduledFor: '' }));
      if (fileRef.current) fileRef.current.value = '';
    } catch (err: unknown) { toast.error('Launch failed: ' + (err as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Launch a campaign" subtitle="Upload a recipient list, write your email, and send — in one step. Unsubscribed/suppressed contacts are skipped and an unsubscribe link is added automatically." />

      <form className="space-y-6" onSubmit={launch}>
        <Card>
          <h2 className="font-heading font-semibold text-ink mb-1">1. Upload recipients</h2>
          <p className="text-sm text-ink-dim mb-4">CSV with an <code className="font-mono">email</code> column (a <code className="font-mono">name</code> column and any extra columns become merge fields like <code className="font-mono">{'{{'}name{'}}'}</code>).</p>
          <div className="flex items-center gap-3">
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} />
            <Button type="button" variant="secondary" onClick={() => fileRef.current?.click()}>Choose CSV</Button>
            <span className="text-sm text-ink-muted">{rows.length ? `${rows.length} recipients — ${fileName}` : 'No file chosen'}</span>
          </div>
        </Card>

        <Card>
          <h2 className="font-heading font-semibold text-ink mb-4">2. Your email</h2>
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="Campaign name"><Input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Spring promo" /></Field>
              <Field label="From (sender)">
                <select className={selectCls} value={form.senderId} onChange={e => setForm({ ...form, senderId: e.target.value })}>
                  {senders.map(s => <option key={s.id} value={s.id}>{s.display_name} — {s.email}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Subject"><Input required value={form.subject} onChange={e => setForm({ ...form, subject: e.target.value })} placeholder="Hi {{name}}, a quick update" /></Field>
            <Field label="Email body (HTML)" hint="Use {{name}}, {{email}}, or any CSV column as a placeholder.">
              <textarea required className={`${selectCls} min-h-[180px] font-mono`} value={form.bodyHtml} onChange={e => setForm({ ...form, bodyHtml: e.target.value })} placeholder="<p>Hello {{name}},</p>" />
            </Field>
            <Field label="Attachments (optional)" hint="PDFs or other files sent with every email. Keep the total under ~3 MB.">
              <input ref={attachRef} type="file" accept=".pdf,application/pdf" multiple className="hidden" onChange={onAttach} />
              <div className="flex items-center gap-3">
                <Button type="button" variant="secondary" onClick={() => attachRef.current?.click()}>Attach files</Button>
                {!attachments.length && <span className="text-sm text-ink-muted">No files attached</span>}
              </div>
              {attachments.length > 0 && (
                <ul className="mt-3 space-y-1">
                  {attachments.map(a => (
                    <li key={a.filename} className="flex items-center justify-between rounded-lg border border-line-strong bg-surface-raised px-3 py-2 text-sm">
                      <span className="truncate text-ink">{a.filename}</span>
                      <button type="button" className="ml-3 shrink-0 text-ink-muted hover:text-accent" onClick={() => removeAttachment(a.filename)}>Remove</button>
                    </li>
                  ))}
                </ul>
              )}
            </Field>
          </div>
        </Card>

        <Card>
          <h2 className="font-heading font-semibold text-ink mb-4">3. Launch</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-end">
            <Field label="Schedule (optional)" hint="Blank = send now."><Input type="datetime-local" value={form.scheduledFor} onChange={e => setForm({ ...form, scheduledFor: e.target.value })} /></Field>
            <Field label="List name (optional)" hint="The uploaded recipients are saved as a reusable list."><Input value={form.listName} onChange={e => setForm({ ...form, listName: e.target.value })} placeholder="(defaults to the campaign name)" /></Field>
          </div>
          <div className="flex justify-end mt-4">
            <Button type="submit" disabled={busy}>{busy ? 'Launching…' : (<span className="flex items-center gap-2"><Rocket size={16} /> Launch campaign</span>)}</Button>
          </div>
        </Card>
      </form>
    </div>
  );
}
