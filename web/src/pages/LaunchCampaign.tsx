import { useEffect, useMemo, useRef, useState } from 'react';
import { upload } from '@vercel/blob/client';
import { Rocket } from 'lucide-react';
import { api } from '@aiployee/ui';
import { Button } from '@aiployee/ui';
import { Input, Field } from '@aiployee/ui';
import { Card } from '@aiployee/ui';
import { PageHeader } from '@aiployee/ui';
import { useToast } from '@aiployee/ui';

interface Sender { id: string; email: string; display_name: string }
type Row = { email: string; name?: string; attributes: Record<string, string> };
type Attachment = { filename: string; url: string; content_type?: string };

const selectCls = 'w-full rounded-lg border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent';

// Per-file ceiling — matches the server token's maximumSizeInBytes (typical mailbox limit).
const MAX_FILE_BYTES = 25 * 1024 * 1024;

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
  const [uploading, setUploading] = useState(false);
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
    setUploading(true);
    try {
      for (const file of files) {
        if (attachments.some(a => a.filename === file.name)) continue; // de-dupe by name
        if (file.size > MAX_FILE_BYTES) { toast.error(`${file.name} is over 25 MB`); continue; }
        // Stream the file straight to Vercel Blob; /api/blob/upload only mints the token.
        const blob = await upload(file.name, file, {
          access: 'public',
          handleUploadUrl: '/api/blob/upload',
          contentType: file.type || undefined,
        });
        setAttachments(prev => [...prev, { filename: file.name, url: blob.url, content_type: file.type || undefined }]);
      }
    } catch (err: unknown) {
      toast.error('Upload failed: ' + (err as Error).message);
    } finally {
      setUploading(false);
    }
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

  // Merge fields available from the uploaded CSV: email + name (if present) + every extra column.
  // These are the {{placeholders}} the user can drop into the subject/body for this campaign.
  const mergeFields = useMemo(() => {
    if (!rows.length) return [];
    const keys = new Set<string>(['email']);
    if (rows.some(r => r.name)) keys.add('name');
    rows.forEach(r => Object.keys(r.attributes).forEach(k => k && keys.add(k)));
    return [...keys];
  }, [rows]);

  function downloadTemplate() {
    const csv = 'email,name,company,renewal_date\njane@example.com,Jane,Acme Corp,2026-07-01\nsam@example.com,Sam,Globex,2026-08-15\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'campaign-recipients-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  function insertField(field: string) {
    const token = `{{${field}}}`;
    setForm(f => ({ ...f, bodyHtml: f.bodyHtml ? `${f.bodyHtml} ${token}` : token }));
    toast.success(`Added ${token} to the email body`);
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Launch a campaign" subtitle="Upload a recipient list, write your email, and send — in one step. Unsubscribed/suppressed contacts are skipped and an unsubscribe link is added automatically." />

      <form className="space-y-6" onSubmit={launch}>
        <Card>
          <h2 className="font-heading font-semibold text-ink mb-1">1. Upload recipients</h2>
          <p className="text-sm text-ink-dim mb-2">One CSV — <strong>one row per recipient</strong>. It's both your contact list and each person's details for this campaign.</p>
          <ul className="text-sm text-ink-dim mb-4 space-y-1 list-disc pl-5">
            <li><code className="font-mono">email</code> — required; this is the address the campaign sends to.</li>
            <li><code className="font-mono">name</code> — optional; available as <code className="font-mono">{'{{'}name{'}}'}</code>.</li>
            <li>Any other columns (e.g. <code className="font-mono">company</code>) become per-recipient merge fields you can drop into the email as <code className="font-mono">{'{{'}company{'}}'}</code>.</li>
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} />
            <Button type="button" variant="secondary" onClick={() => fileRef.current?.click()}>Choose CSV</Button>
            <Button type="button" variant="ghost" onClick={downloadTemplate}>Download template</Button>
            <span className="text-sm text-ink-muted">{rows.length ? `${rows.length} recipients — ${fileName}` : 'No file chosen'}</span>
          </div>
          {mergeFields.length > 0 && (
            <div className="mt-4 rounded-lg border border-line-strong bg-surface-raised p-3">
              <p className="text-sm text-ink-dim mb-2">Detected columns — click to add to your email body:</p>
              <div className="flex flex-wrap gap-2">
                {mergeFields.map(f => (
                  <button key={f} type="button" onClick={() => insertField(f)}
                    className="rounded-md border border-line-strong bg-surface px-2 py-1 font-mono text-xs text-ink hover:border-accent hover:text-accent">
                    {`{{${f}}}`}
                  </button>
                ))}
              </div>
            </div>
          )}
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
            <Field label="Attachments (optional)" hint="PDFs sent with every email — up to 25 MB each.">
              <input ref={attachRef} type="file" accept=".pdf,application/pdf" multiple className="hidden" onChange={onAttach} />
              <div className="flex items-center gap-3">
                <Button type="button" variant="secondary" disabled={uploading} onClick={() => attachRef.current?.click()}>{uploading ? 'Uploading…' : 'Attach files'}</Button>
                {!attachments.length && !uploading && <span className="text-sm text-ink-muted">No files attached</span>}
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
            <Button type="submit" disabled={busy || uploading}>{busy ? 'Launching…' : (<span className="flex items-center gap-2"><Rocket size={16} /> Launch campaign</span>)}</Button>
          </div>
        </Card>
      </form>
    </div>
  );
}
