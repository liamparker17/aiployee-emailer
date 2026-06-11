import { useEffect, useState } from 'react';
import {
  listFlows, createFlow, getFlow, saveSteps, activateFlow, pauseFlow, archiveFlow,
  enrollFlow, listEnrollments,
  type FlowWithCounts, type FlowStep, type StepInput, type StepKind, type Enrollment, type FlowCounts,
} from '../lib/flows';
import { listTriggers, type JobixTrigger } from '../lib/jobixTriggers';
import { PageHeader } from '@aiployee/ui';
import { Card } from '@aiployee/ui';
import { Table, Th, Td } from '@aiployee/ui';
import { Button } from '@aiployee/ui';
import { Input, Field } from '@aiployee/ui';
import { EmptyState } from '@aiployee/ui';
import { useToast } from '@aiployee/ui';
import { Workflow } from 'lucide-react';

const SELECT = 'rounded-btn border border-line bg-surface-raised text-ink text-sm px-2 py-1.5';
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);

function StepEditor({ step, triggers, onChange }: { step: StepInput; triggers: JobixTrigger[]; onChange: (c: Record<string, unknown>) => void }) {
  const c = step.config;
  if (step.kind === 'wait') {
    return (
      <div className="flex flex-wrap gap-2 items-end">
        {(['days', 'hours', 'minutes'] as const).map(u => (
          <Field key={u} label={u}>
            <Input type="number" min={0} value={String(num(c[u]))} onChange={e => onChange({ ...c, [u]: Number(e.target.value) })} />
          </Field>
        ))}
      </div>
    );
  }
  if (step.kind === 'jobix_call') {
    return (
      <Field label="Jobix call trigger">
        <select className={SELECT} value={String(c.triggerId ?? '')} onChange={e => onChange({ ...c, triggerId: e.target.value })}>
          <option value="">Select a trigger…</option>
          {triggers.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </Field>
    );
  }
  if (step.kind === 'whatsapp_send') {
    return (
      <Field label="WhatsApp message" hint="Sent to the contact's phone via your WhatsApp connection. Merge fields: {{name}}, {{phone}} and any context field.">
        <textarea
          className={`${SELECT} w-full min-h-[80px]`}
          value={String(c.message ?? '')}
          placeholder="Hi {{name}}, …"
          onChange={e => onChange({ ...c, message: e.target.value })}
        />
      </Field>
    );
  }
  // condition
  const op = String(c.op ?? 'exists');
  return (
    <div className="flex flex-wrap gap-2 items-end">
      <Field label="Field"><Input value={String(c.field ?? '')} placeholder="e.g. context, vip" onChange={e => onChange({ ...c, field: e.target.value })} /></Field>
      <Field label="Test">
        <select className={SELECT} value={op} onChange={e => onChange({ ...c, op: e.target.value })}>
          <option value="exists">exists</option>
          <option value="not_exists">does not exist</option>
          <option value="eq">equals</option>
          <option value="neq">not equals</option>
        </select>
      </Field>
      {(op === 'eq' || op === 'neq') && (
        <Field label="Value"><Input value={String(c.value ?? '')} onChange={e => onChange({ ...c, value: e.target.value })} /></Field>
      )}
      <Field label="If it fails">
        <select className={SELECT} value={String(c.onFail ?? 'exit')} onChange={e => onChange({ ...c, onFail: e.target.value })}>
          <option value="exit">exit the flow</option>
          <option value="continue">continue anyway</option>
        </select>
      </Field>
    </div>
  );
}

export default function Flows() {
  const toast = useToast();
  const [flows, setFlows] = useState<FlowWithCounts[]>([]);
  const [triggers, setTriggers] = useState<JobixTrigger[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [steps, setSteps] = useState<StepInput[]>([]);
  const [counts, setCounts] = useState<FlowCounts | null>(null);
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [newName, setNewName] = useState('');
  const [enrollText, setEnrollText] = useState('');
  const [context, setContext] = useState('');

  const reloadFlows = () => listFlows().then(r => setFlows(r.flows)).catch(e => toast.error((e as Error).message));
  useEffect(() => { reloadFlows(); listTriggers().then(r => setTriggers(r.triggers)).catch(() => {}); }, []);

  const selectedFlow = flows.find(f => f.id === selected) ?? null;

  async function openFlow(id: string) {
    setSelected(id);
    try {
      const f = await getFlow(id);
      setSteps(f.steps.map((s: FlowStep) => ({ kind: s.kind, config: s.config ?? {} })));
      setCounts(f.counts);
      const e = await listEnrollments(id);
      setEnrollments(e.enrollments);
    } catch (err) { toast.error((err as Error).message); }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try { const r = await createFlow(newName); setNewName(''); await reloadFlows(); openFlow(r.flow.id); toast.success('Flow created'); }
    catch (err) { toast.error((err as Error).message); }
  }

  function addStep(kind: StepKind) {
    const config: Record<string, unknown> =
      kind === 'wait' ? { days: 1 } : kind === 'condition' ? { op: 'exists', onFail: 'exit' } : kind === 'whatsapp_send' ? { message: '' } : {};
    setSteps(s => [...s, { kind, config }]);
  }
  const patchStep = (i: number, config: Record<string, unknown>) => setSteps(s => s.map((x, j) => j === i ? { ...x, config } : x));
  const removeStep = (i: number) => setSteps(s => s.filter((_, j) => j !== i));
  const moveStep = (i: number, dir: -1 | 1) => setSteps(s => {
    const j = i + dir; if (j < 0 || j >= s.length) return s;
    const next = [...s]; [next[i], next[j]] = [next[j], next[i]]; return next;
  });

  async function persistSteps() {
    if (!selected) return;
    try { await saveSteps(selected, steps); await reloadFlows(); toast.success('Steps saved'); }
    catch (err) { toast.error((err as Error).message); }
  }

  async function doAction(fn: () => Promise<unknown>, msg: string) {
    try { await fn(); await reloadFlows(); if (selected) await openFlow(selected); toast.success(msg); }
    catch (err) { toast.error((err as Error).message); }
  }

  async function doEnroll() {
    if (!selected) return;
    const recipients = enrollText.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
      const [name, phone] = line.split(',').map(x => (x ?? '').trim());
      return { name: name ?? '', phone: phone ?? '', context: context ? { context } : undefined };
    });
    if (recipients.length === 0) { toast.error('Add at least one "name, phone" line'); return; }
    try {
      const r = await enrollFlow(selected, recipients);
      setEnrollText('');
      await openFlow(selected); await reloadFlows();
      toast.success(`${r.added} enrolled${r.errors.length ? `, ${r.errors.length} skipped` : ''}`);
    } catch (err) { toast.error((err as Error).message); }
  }

  return (
    <div>
      <PageHeader title="Flows" subtitle="Build campaign flows — enrol contacts and walk them through steps (call, wait, branch)." />

      <details className="mb-4 rounded-card border border-line bg-surface-raised">
        <summary className="cursor-pointer select-none px-4 py-3 font-medium text-ink">
          How to connect a Call step to Jobix (one-time setup)
        </summary>
        <div className="px-4 pb-4 space-y-3 text-sm text-ink-muted">
          <p>A <b>Call</b> step rings a customer using your Jobix voice agent. To make calls actually go out, set this up once:</p>
          <ol className="list-decimal pl-5 space-y-2">
            <li><b>In Jobix:</b> build an automation that <b>starts with a Webhook trigger</b> and <b>ends with a Call</b>. Click <b>Generate</b> to create a token and copy it. (Map the JSON we send — <code>name</code>, <code>phone</code>, <code>context</code> — into who it calls and what the agent says.)</li>
            <li><b>In this app, on the Webhooks page → "Jobix Call Triggers":</b> add a trigger, paste that token, set the payload template with <code>{'{{name}}'}</code> <code>{'{{phone}}'}</code> <code>{'{{context}}'}</code>, then click <b>Test</b> until you get a green result. That green is your proof Jobix is connected.</li>
            <li><b>Back here:</b> add a <b>Call</b> step and pick that trigger. Add <b>Wait</b> / <b>Condition</b> steps if you like, click <b>Save steps</b>, then <b>Activate</b> the flow and <b>enrol</b> your contacts below.</li>
          </ol>
          <p className="text-ink-dim"><b>Heads up:</b> calls go out as soon as you enrol someone into an <b>active</b> flow — test with your own number first. Pause the flow any time to stop everyone mid-sequence.</p>
        </div>
      </details>

      <Card>
        <h3>Your flows</h3>
        <form onSubmit={create} className="flex gap-2 items-end mb-3">
          <Field label="New flow name"><Input value={newName} onChange={e => setNewName(e.target.value)} required /></Field>
          <Button type="submit">Create</Button>
        </form>
        {flows.length === 0 ? <EmptyState icon={Workflow} title="No flows yet" /> : (
          <Table>
            <thead><tr><Th>Name</Th><Th>Status</Th><Th>Steps</Th><Th>Enrolled (active/total)</Th><Th>Actions</Th></tr></thead>
            <tbody>{flows.map(f => (
              <tr key={f.id}>
                <Td><a className="cursor-pointer text-accent" onClick={() => openFlow(f.id)}>{f.name}</a></Td>
                <Td>{f.status}</Td>
                <Td>{f.step_count}</Td>
                <Td>{f.active_enrollments}/{f.total_enrollments}</Td>
                <Td>
                  {f.status === 'draft' || f.status === 'paused'
                    ? <Button onClick={() => doAction(() => activateFlow(f.id), 'Flow activated')}>Activate</Button>
                    : f.status === 'active'
                      ? <Button variant="secondary" onClick={() => doAction(() => pauseFlow(f.id), 'Flow paused')}>Pause</Button>
                      : null}
                  {f.status !== 'archived' && <Button variant="ghost" onClick={() => doAction(() => archiveFlow(f.id), 'Flow archived')}>Archive</Button>}
                </Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </Card>

      {selectedFlow && (
        <Card>
          <h3>{selectedFlow.name} — steps</h3>
          <p className="text-sm text-ink-muted mb-2">Steps run top to bottom for each enrolled contact. A <b>wait</b> pauses; a <b>call</b> fires a Jobix trigger; a <b>WhatsApp</b> step messages the contact; a <b>condition</b> can exit the flow.</p>
          <div className="space-y-2">
            {steps.map((s, i) => (
              <div key={i} className="rounded-card border border-line p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium">{i + 1}. {s.kind === 'jobix_call' ? 'Call (Jobix)' : s.kind === 'wait' ? 'Wait' : s.kind === 'whatsapp_send' ? 'WhatsApp' : 'Condition'}</span>
                  <div className="flex gap-1">
                    <Button variant="ghost" onClick={() => moveStep(i, -1)}>↑</Button>
                    <Button variant="ghost" onClick={() => moveStep(i, 1)}>↓</Button>
                    <Button variant="ghost" onClick={() => removeStep(i)}>Remove</Button>
                  </div>
                </div>
                <StepEditor step={s} triggers={triggers} onChange={c => patchStep(i, c)} />
              </div>
            ))}
          </div>
          <div className="flex gap-2 mt-3 flex-wrap">
            <Button variant="secondary" onClick={() => addStep('jobix_call')}>+ Call</Button>
            <Button variant="secondary" onClick={() => addStep('whatsapp_send')}>+ WhatsApp</Button>
            <Button variant="secondary" onClick={() => addStep('wait')}>+ Wait</Button>
            <Button variant="secondary" onClick={() => addStep('condition')}>+ Condition</Button>
            <Button onClick={persistSteps}>Save steps</Button>
          </div>

          <div className="mt-6">
            <h3>Enrol contacts</h3>
            <p className="text-sm text-ink-muted mb-2">One per line as <code>name, phone</code>. They start at step 1 once the flow is active.</p>
            <textarea className="w-full font-mono text-sm rounded-btn border border-line bg-surface-raised p-2" rows={4}
              value={enrollText} onChange={e => setEnrollText(e.target.value)} placeholder={'Renier, +27609381283\nJulie, +27821234567'} />
            <Field label="Context note (optional — available as {{context}} in your call trigger)">
              <Input value={context} onChange={e => setContext(e.target.value)} placeholder="e.g. unhappy about claim delay" />
            </Field>
            <Button onClick={doEnroll}>Enrol</Button>
          </div>

          {counts && (
            <div className="mt-6">
              <h3>Enrollments <span className="text-sm text-ink-muted">(active {counts.active} · completed {counts.completed} · exited {counts.exited} · failed {counts.failed})</span></h3>
              {enrollments.length === 0 ? <EmptyState icon={Workflow} title="No one enrolled yet" /> : (
                <Table>
                  <thead><tr><Th>Name</Th><Th>Phone</Th><Th>Status</Th><Th>Step</Th><Th>Error</Th></tr></thead>
                  <tbody>{enrollments.map(e => (
                    <tr key={e.id}><Td>{e.name}</Td><Td>{e.phone}</Td><Td>{e.status}</Td><Td>{e.current_position + 1}</Td><Td>{e.last_error ?? ''}</Td></tr>
                  ))}</tbody>
                </Table>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
