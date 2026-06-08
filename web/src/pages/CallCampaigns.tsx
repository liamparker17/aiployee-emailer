import { useEffect, useRef, useState } from 'react';
import { PhoneOutgoing, Bot, Plus, Trash2, CheckCircle2, PauseCircle, XCircle, Upload, Users } from 'lucide-react';
import {
  listAgents, createAgent,
  listCampaigns, createCampaign,
  addCsvRecipients, listRecipients,
  approveCampaign, pauseCampaign, resumeCampaign, cancelCampaign,
  type CallAgent, type CallCampaign, type Recipient, type ValuesField,
} from '../lib/callCampaigns';
import { Table, Th, Td } from '@aiployee/ui';
import { Button } from '@aiployee/ui';
import { Input, Field } from '@aiployee/ui';
import { Card } from '@aiployee/ui';
import { PageHeader } from '@aiployee/ui';
import { EmptyState } from '@aiployee/ui';
import { Skeleton } from '@aiployee/ui';
import { useToast } from '@aiployee/ui';

// ── CSV parser ────────────────────────────────────────────────────────────────
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const cells = line.split(',');
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = (cells[i] ?? '').trim(); });
    return row;
  });
}

// ── Status badge ──────────────────────────────────────────────────────────────
const STATUS_COLOR: Record<string, string> = {
  draft: 'text-ink-dim',
  approved: 'text-amber-400',
  running: 'text-green-400',
  paused: 'text-amber-400',
  completed: 'text-success',
  canceled: 'text-error',
  pending: 'text-ink-dim',
  queued: 'text-amber-400',
  launched: 'text-green-400',
  failed: 'text-error',
  suppressed: 'text-ink-dim',
};
function StatusBadge({ status }: { status: string }) {
  return <span className={`text-xs font-medium capitalize ${STATUS_COLOR[status] ?? 'text-ink-muted'}`}>{status}</span>;
}

// ─────────────────────────────────────────────────────────────────────────────
export default function CallCampaigns() {
  const toast = useToast();

  // Data
  const [agents, setAgents] = useState<CallAgent[]>([]);
  const [campaigns, setCampaigns] = useState<CallCampaign[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [loading, setLoading] = useState(true);

  // Agent form
  type SchemaRow = ValuesField & { _id: string };
  const [agentLabel, setAgentLabel] = useState('');
  const [agentKey, setAgentKey] = useState('');
  const [agentSchema, setAgentSchema] = useState<SchemaRow[]>([]);

  // Campaign form
  const [campName, setCampName] = useState('');
  const [campAgent, setCampAgent] = useState('');

  // CSV input ref
  const fileRef = useRef<HTMLInputElement>(null);

  // ── load ────────────────────────────────────────────────────────────────────
  async function reload() {
    const [a, c] = await Promise.all([listAgents(), listCampaigns()]);
    setAgents(a.agents);
    setCampaigns(c.campaigns);
  }

  useEffect(() => {
    setLoading(true);
    reload().catch(e => toast.error((e as Error).message)).finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selected) { setRecipients([]); return; }
    listRecipients(selected)
      .then(r => setRecipients(r.recipients))
      .catch(e => toast.error((e as Error).message));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // ── agent submit ────────────────────────────────────────────────────────────
  async function submitAgent(e: React.FormEvent) {
    e.preventDefault();
    try {
      await createAgent({ label: agentLabel, company_key: agentKey, values_schema: agentSchema.map(({ _id, ...f }) => f) });
      setAgentLabel(''); setAgentKey(''); setAgentSchema([]);
      await reload();
      toast.success('Agent registered');
    } catch (err) { toast.error((err as Error).message); }
  }

  // ── campaign submit ─────────────────────────────────────────────────────────
  async function submitCampaign(e: React.FormEvent) {
    e.preventDefault();
    try {
      const c = await createCampaign({ agent_id: campAgent, name: campName, audience_type: 'csv' });
      setCampName(''); setCampAgent('');
      await reload();
      setSelected(c.campaign.id);
      toast.success('Draft created — add recipients');
    } catch (err) { toast.error((err as Error).message); }
  }

  // ── CSV upload ──────────────────────────────────────────────────────────────
  async function onCsvChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !selected) return;
    try {
      const rows = parseCsv(await file.text());
      const res = await addCsvRecipients(selected, rows);
      await reload();
      const r = await listRecipients(selected);
      setRecipients(r.recipients);
      toast.success(`${res.added} added${res.errors.length ? `, ${res.errors.length} skipped` : ''}`);
    } catch (err) { toast.error((err as Error).message); }
    // reset so the same file can be re-uploaded
    if (fileRef.current) fileRef.current.value = '';
  }

  // ── campaign action helper ──────────────────────────────────────────────────
  async function doAction(fn: () => Promise<unknown>) {
    try { await fn(); await reload(); } catch (err) { toast.error((err as Error).message); }
  }

  // ── schema builder helpers ──────────────────────────────────────────────────
  function addField() {
    setAgentSchema(s => [...s, { _id: crypto.randomUUID(), key: '', label: '', required: false }]);
  }
  function removeField(id: string) {
    setAgentSchema(s => s.filter(f => f._id !== id));
  }
  function patchField(id: string, patch: Partial<ValuesField>) {
    setAgentSchema(s => s.map(f => f._id === id ? { ...f, ...patch } : f));
  }

  const activeAgents = agents.filter(a => a.active);
  const selectedCampaign = campaigns.find(c => c.id === selected) ?? null;

  // ── render ──────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-8">
      <PageHeader
        title="Outbound Calls"
        subtitle="Manage call agents, build campaigns, and upload recipient lists."
      />

      {/* ══════════════════════ AGENTS ══════════════════════ */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold text-ink flex items-center gap-2">
          <Bot size={16} className="text-magenta" /> Agents
        </h2>

        {/* Agents table */}
        {loading ? (
          <div className="space-y-2">{[0, 1].map(i => <Skeleton key={i} className="h-9" />)}</div>
        ) : agents.length === 0 ? (
          <EmptyState icon={Bot} title="No agents yet" description="Register an agent below to start making calls." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Label</Th>
                <Th>Fields</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {agents.map(a => (
                <tr key={a.id}>
                  <Td>{a.label}</Td>
                  <Td>{a.values_schema.length} field{a.values_schema.length !== 1 ? 's' : ''}</Td>
                  <Td><StatusBadge status={a.active ? 'active' : 'inactive'} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}

        {/* Register agent form */}
        <Card>
          <form onSubmit={submitAgent} className="space-y-4">
            <p className="text-sm font-medium text-ink">Register agent</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Label">
                <Input required value={agentLabel} onChange={e => setAgentLabel(e.target.value)} placeholder="My Jobix Agent" />
              </Field>
              <Field label="Company key (write-only)" hint="Stored encrypted; not shown after save.">
                <Input required value={agentKey} onChange={e => setAgentKey(e.target.value)} placeholder="jobix-company-key" />
              </Field>
            </div>

            {/* Values schema builder */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-ink-muted">Call values schema</span>
                <Button type="button" variant="ghost" onClick={addField}>
                  <Plus size={14} /> Add field
                </Button>
              </div>
              {agentSchema.length > 0 && (
                <div className="space-y-2">
                  {agentSchema.map((f) => (
                    <div key={f._id} className="flex items-center gap-2">
                      <Input
                        placeholder="key"
                        value={f.key}
                        onChange={e => patchField(f._id, { key: e.target.value })}
                        className="w-32"
                      />
                      <Input
                        placeholder="label"
                        value={f.label}
                        onChange={e => patchField(f._id, { label: e.target.value })}
                      />
                      <label className="flex items-center gap-1.5 text-sm text-ink-muted whitespace-nowrap">
                        <input
                          type="checkbox"
                          checked={f.required}
                          onChange={e => patchField(f._id, { required: e.target.checked })}
                          className="rounded"
                        />
                        Required
                      </label>
                      <button
                        type="button"
                        onClick={() => removeField(f._id)}
                        className="text-ink-dim hover:text-error transition"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Button type="submit">Register agent</Button>
          </form>
        </Card>
      </section>

      {/* ══════════════════════ CAMPAIGNS ══════════════════════ */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold text-ink flex items-center gap-2">
          <PhoneOutgoing size={16} className="text-magenta" /> Campaigns
        </h2>

        {/* Create campaign form */}
        <Card>
          <form onSubmit={submitCampaign} className="flex items-end gap-3 flex-wrap">
            <Field label="Campaign name">
              <Input required value={campName} onChange={e => setCampName(e.target.value)} placeholder="June outbound sweep" />
            </Field>
            <Field label="Agent">
              <select
                required
                value={campAgent}
                onChange={e => setCampAgent(e.target.value)}
                className="w-full rounded-lg border border-line-strong bg-surface-raised text-ink px-3 py-2 text-sm transition focus:outline-none focus:border-accent focus:ring-2 focus:ring-magenta/40"
              >
                <option value="">Select agent…</option>
                {activeAgents.map(a => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </select>
            </Field>
            <Button type="submit">Create draft</Button>
          </form>
        </Card>

        {/* Campaigns table */}
        {loading ? (
          <div className="space-y-2">{[0, 1].map(i => <Skeleton key={i} className="h-9" />)}</div>
        ) : campaigns.length === 0 ? (
          <EmptyState icon={PhoneOutgoing} title="No campaigns yet" description="Create a draft campaign above, then upload recipients." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Status</Th>
                <Th>Progress</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map(c => (
                <tr
                  key={c.id}
                  className={`cursor-pointer ${selected === c.id ? 'bg-magenta/10' : 'hover:bg-surface-raised/50'}`}
                  onClick={() => setSelected(c.id === selected ? null : c.id)}
                >
                  <Td>
                    <span className={`font-medium ${selected === c.id ? 'text-white' : 'text-ink'}`}>{c.name}</span>
                  </Td>
                  <Td><StatusBadge status={c.status} /></Td>
                  <Td>
                    {c.recipient_count > 0
                      ? `${c.counts.launched + c.counts.completed} / ${c.recipient_count}`
                      : '—'}
                  </Td>
                  <Td>
                    <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                      {c.status === 'draft' && (
                        <Button
                          variant="secondary"
                          onClick={() => doAction(() => approveCampaign(c.id))}
                          title="Approve"
                        >
                          <CheckCircle2 size={14} /> Approve
                        </Button>
                      )}
                      {(c.status === 'approved' || c.status === 'running') && (
                        <Button
                          variant="secondary"
                          onClick={() => doAction(() => pauseCampaign(c.id))}
                          title="Pause"
                        >
                          <PauseCircle size={14} /> Pause
                        </Button>
                      )}
                      {c.status === 'paused' && (
                        <Button
                          variant="secondary"
                          onClick={() => doAction(() => resumeCampaign(c.id))}
                          title="Resume"
                        >
                          <CheckCircle2 size={14} /> Resume
                        </Button>
                      )}
                      {c.status !== 'canceled' && c.status !== 'completed' && (
                        <Button
                          variant="danger"
                          onClick={() => {
                            if (confirm(`Cancel campaign "${c.name}"?`))
                              doAction(() => cancelCampaign(c.id));
                          }}
                          title="Cancel"
                        >
                          <XCircle size={14} /> Cancel
                        </Button>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      {/* ══════════════════════ RECIPIENTS ══════════════════════ */}
      {selected && (
        <section className="space-y-4">
          <h2 className="text-base font-semibold text-ink flex items-center gap-2">
            <Users size={16} className="text-magenta" />
            Recipients — {selectedCampaign?.name ?? selected}
          </h2>

          {/* CSV upload */}
          <Card>
            <div className="flex items-center gap-4">
              <input
                ref={fileRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={onCsvChange}
              />
              <Button
                variant="secondary"
                type="button"
                onClick={() => fileRef.current?.click()}
              >
                <Upload size={14} /> Upload CSV
              </Button>
              <p className="text-sm text-ink-dim">
                CSV must have a header row. Columns: <code className="text-xs bg-surface px-1 py-0.5 rounded">name</code>, <code className="text-xs bg-surface px-1 py-0.5 rounded">phone</code>, plus any agent field keys.
              </p>
            </div>
          </Card>

          {/* Recipients table */}
          {recipients.length === 0 ? (
            <EmptyState icon={Users} title="No recipients yet" description="Upload a CSV to add recipients to this campaign." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Phone</Th>
                  <Th>Status</Th>
                  <Th>Outcome</Th>
                </tr>
              </thead>
              <tbody>
                {recipients.map(r => (
                  <tr key={r.id}>
                    <Td>{r.name || '—'}</Td>
                    <Td>{r.phone}</Td>
                    <Td><StatusBadge status={r.status} /></Td>
                    <Td>{r.outcome ?? '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      )}
    </div>
  );
}
