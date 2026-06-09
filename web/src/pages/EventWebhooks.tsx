import { useEffect, useState, Fragment, type FormEvent, type ChangeEvent } from 'react';
import { Webhook } from 'lucide-react';
import { api } from '../api';
import { Table, Th, Td } from '../components/Table';
import { Button } from '../components/Button';
import { Input, Field } from '../components/Input';
import { Card } from '../components/Card';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';
import { useToast } from '../components/Toast';
import {
  listTriggers, createTrigger, updateTrigger, deleteTrigger, testTrigger, fireTrigger, listFires,
  type JobixTrigger, type FireResult, type FireRow, type TokenPlacement,
} from '../lib/jobixTriggers';

const ALL_EVENTS = ['sent', 'delivered', 'bounced', 'complained'] as const;
type EventName = typeof ALL_EVENTS[number];

interface Webhook_ {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  has_secret: boolean;
  created_at: string;
}

const EVENT_LABELS: Record<EventName, string> = {
  sent: 'Sent',
  delivered: 'Delivered',
  bounced: 'Bounced',
  complained: 'Complained',
};

function EventChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-surface-raised text-ink-muted border border-line">
      {label}
    </span>
  );
}

export default function EventWebhooks() {
  const [items, setItems] = useState<Webhook_[]>([]);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  const refresh = () =>
    api<{ webhooks: Webhook_[] }>('/api/event-webhooks')
      .then(r => setItems(r.webhooks))
      .finally(() => setLoading(false));

  useEffect(() => { refresh(); }, []);

  const handleRemove = async (hook: Webhook_) => {
    if (!confirm(`Remove webhook for ${hook.url}?`)) return;
    try {
      await api(`/api/event-webhooks/${hook.id}`, { method: 'DELETE' });
      toast.success('Webhook removed');
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="space-y-8">
      <PageHeader
        title="Webhooks"
        subtitle="Configure event webhooks and Jobix call triggers."
      />

      {/* ── Event webhooks section ── */}
      <div className="space-y-4">
        <h2 className="text-base font-semibold text-ink">Event webhooks</h2>
        <p className="text-sm text-ink-muted">Get notified when emails are sent, delivered, bounced, or marked as spam.</p>

        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={Webhook} title="No webhooks yet" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>URL</Th>
                <Th>Events</Th>
                <Th>Secret</Th>
                <Th>{''}</Th>
              </tr>
            </thead>
            <tbody>
              {items.map(hook => (
                <tr key={hook.id}>
                  <Td>
                    <span className="font-mono text-sm text-ink break-all">{hook.url}</span>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {hook.events.map(ev => (
                        <EventChip key={ev} label={EVENT_LABELS[ev as EventName] ?? ev} />
                      ))}
                    </div>
                  </Td>
                  <Td>
                    <span className="text-xs text-ink-muted">
                      {hook.has_secret ? 'Configured' : 'None'}
                    </span>
                  </Td>
                  <Td>
                    <Button variant="danger" onClick={() => handleRemove(hook)}>
                      Remove
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}

        <AddWebhookForm onAdded={refresh} />
      </div>

      {/* ── Jobix Call Triggers section ── */}
      <JobixTriggersSection />
    </div>
  );
}

function AddWebhookForm({ onAdded }: { onAdded: () => void }) {
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<Set<EventName>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();

  const toggleEvent = (ev: EventName) => {
    setSelectedEvents(prev => {
      const next = new Set(prev);
      if (next.has(ev)) next.delete(ev); else next.add(ev);
      return next;
    });
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!url.trim()) { setErr('URL is required.'); return; }
    if (!secret.trim()) { setErr('Secret is required.'); return; }
    if (selectedEvents.size === 0) { setErr('Select at least one event.'); return; }
    setBusy(true);
    try {
      await api('/api/event-webhooks', {
        method: 'POST',
        body: JSON.stringify({ url: url.trim(), secret: secret.trim(), events: [...selectedEvents] }),
      });
      toast.success('Webhook added');
      setUrl('');
      setSecret('');
      setSelectedEvents(new Set());
      onAdded();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-surface-raised border border-line rounded-2xl p-6 space-y-5">
      <h2 className="text-base font-semibold text-ink">Add webhook</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Endpoint URL">
          <Input
            type="url"
            placeholder="https://example.com/hooks/email"
            value={url}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setUrl(e.target.value)}
          />
        </Field>

        <Field label="Signing secret">
          <Input
            type="password"
            placeholder="A strong random secret"
            value={secret}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setSecret(e.target.value)}
          />
        </Field>

        <fieldset>
          <legend className="text-sm font-medium text-ink mb-2">Events to receive</legend>
          <div className="flex flex-wrap gap-4">
            {ALL_EVENTS.map(ev => (
              <label key={ev} className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="rounded border-line accent-brand"
                  checked={selectedEvents.has(ev)}
                  onChange={() => toggleEvent(ev)}
                />
                <span className="text-sm text-ink">{EVENT_LABELS[ev]}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {err && (
          <p className="text-sm text-red-400">{err}</p>
        )}

        <Button type="submit" disabled={busy}>
          {busy ? 'Adding…' : 'Add webhook'}
        </Button>
      </form>
    </div>
  );
}

// ── select className shared with sibling pages ──────────────────────────────
const SELECT_CLS = 'w-full rounded-lg border border-line-strong bg-surface-raised text-ink px-3 py-2 text-sm transition focus:outline-none focus:border-accent focus:ring-2 focus:ring-magenta/40';
const TEXTAREA_CLS = 'w-full rounded-lg border border-line-strong bg-surface-raised text-ink px-3 py-2 text-sm font-mono transition focus:outline-none focus:border-accent focus:ring-2 focus:ring-magenta/40 resize-y';

const PLACEMENT_LABELS: Record<TokenPlacement, string> = {
  bearer: 'Bearer header (Authorization: Bearer …)',
  header: 'Custom header',
  query: 'Query param',
  body: 'Body field',
};

const DEFAULT_TEMPLATE = '{\n  "name": "{{name}}",\n  "phone": "{{phone}}",\n  "reason": "{{context}}"\n}';

function FireResultPanel({ result, onClose }: { result: FireResult; onClose: () => void }) {
  return (
    <Card className="space-y-2">
      <div className="flex items-center justify-between">
        <span className={`text-sm font-semibold ${result.ok ? 'text-success' : 'text-error'}`}>
          {result.ok ? 'Success' : 'Failed'} — HTTP {result.httpStatus ?? 'n/a'}
        </span>
        <Button variant="ghost" onClick={onClose}>Close</Button>
      </div>
      {result.error && <p className="text-xs text-error">{result.error}</p>}
      {result.unresolved.length > 0 && (
        <p className="text-xs text-amber-400">Unresolved vars: {result.unresolved.join(', ')}</p>
      )}
      <div className="space-y-1">
        <p className="text-xs text-ink-muted font-medium">Payload sent</p>
        <pre className="text-xs bg-surface text-ink-muted rounded p-2 overflow-x-auto whitespace-pre-wrap">{result.renderedPayload}</pre>
      </div>
      {result.responseSnippet && (
        <div className="space-y-1">
          <p className="text-xs text-ink-muted font-medium">Response</p>
          <pre className="text-xs bg-surface text-ink-muted rounded p-2 overflow-x-auto whitespace-pre-wrap">{result.responseSnippet}</pre>
        </div>
      )}
    </Card>
  );
}

function FiresTable({ fires }: { fires: FireRow[] }) {
  if (fires.length === 0) return <p className="text-xs text-ink-muted">No fires logged yet.</p>;
  return (
    <Table>
      <thead>
        <tr>
          <Th>When</Th>
          <Th>Source</Th>
          <Th>OK</Th>
          <Th>HTTP</Th>
          <Th>Error</Th>
        </tr>
      </thead>
      <tbody>
        {fires.map(f => (
          <tr key={f.id}>
            <Td><span className="text-xs text-ink-muted">{new Date(f.created_at).toLocaleString()}</span></Td>
            <Td><span className="text-xs text-ink-muted">{f.source}</span></Td>
            <Td><span className={`text-xs font-medium ${f.ok ? 'text-success' : 'text-error'}`}>{f.ok ? 'Yes' : 'No'}</span></Td>
            <Td><span className="text-xs text-ink-muted">{f.http_status ?? '—'}</span></Td>
            <Td><span className="text-xs text-error">{f.error ?? ''}</span></Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function JobixTriggersSection() {
  const toast = useToast();
  const [triggers, setTriggers] = useState<JobixTrigger[]>([]);
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<FireResult | null>(null);
  const [fires, setFires] = useState<Record<string, FireRow[]>>({});

  // Create form state
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('https://dashboard-api.jobix.ai/automation/trigger/webhook');
  const [token, setToken] = useState('');
  const [placement, setPlacement] = useState<TokenPlacement>('bearer');
  const [tokenParam, setTokenParam] = useState('');
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setLoading(true);
    return listTriggers()
      .then(r => setTriggers(r.triggers))
      .catch(e => toast.error((e as Error).message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await createTrigger({
        label,
        url,
        token,
        token_placement: placement,
        token_param: placement === 'bearer' ? undefined : tokenParam,
        payload_template: template,
      });
      setLabel(''); setToken(''); setTokenParam('');
      setUrl('https://dashboard-api.jobix.ai/automation/trigger/webhook');
      setPlacement('bearer');
      setTemplate(DEFAULT_TEMPLATE);
      await load();
      toast.success('Trigger saved');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runTest(t: JobixTrigger) {
    const name = window.prompt('Test name?') ?? '';
    const phone = window.prompt('Test phone?') ?? '';
    const context = window.prompt('Context?') ?? '';
    try {
      const r = await testTrigger(t.id, { name, phone, context });
      setResult(r.result);
    } catch (err) { toast.error((err as Error).message); }
  }

  async function runFire(t: JobixTrigger) {
    const name = window.prompt('Name?') ?? '';
    const phone = window.prompt('Phone?') ?? '';
    const context = window.prompt('Context?') ?? '';
    try {
      const r = await fireTrigger(t.id, { name, phone, context });
      setResult(r.result);
      await load();
      toast.success(r.result.ok ? 'Fired' : 'Fired (see result)');
    } catch (err) { toast.error((err as Error).message); }
  }

  async function toggleActive(t: JobixTrigger) {
    try { await updateTrigger(t.id, { active: !t.active }); await load(); }
    catch (err) { toast.error((err as Error).message); }
  }

  async function remove(t: JobixTrigger) {
    if (!window.confirm(`Delete trigger "${t.label}"?`)) return;
    try { await deleteTrigger(t.id); await load(); }
    catch (err) { toast.error((err as Error).message); }
  }

  async function showLog(t: JobixTrigger) {
    try {
      const r = await listFires(t.id);
      setFires(f => ({ ...f, [t.id]: r.fires }));
    } catch (err) { toast.error((err as Error).message); }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-ink">Jobix Call Triggers</h2>
        <p className="text-sm text-ink-muted mt-1">Fire a Jobix webhook when a call event needs to be forwarded.</p>
      </div>

      {/* Result panel */}
      {result && <FireResultPanel result={result} onClose={() => setResult(null)} />}

      {/* Triggers table */}
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
      ) : triggers.length === 0 ? (
        <EmptyState icon={Webhook} title="No call triggers yet" />
      ) : (
        <div className="space-y-4">
          <Table>
            <thead>
              <tr>
                <Th>Label</Th>
                <Th>URL</Th>
                <Th>Auth</Th>
                <Th>Active</Th>
                <Th>Last fired</Th>
                <Th>{''}</Th>
              </tr>
            </thead>
            <tbody>
              {triggers.map(t => (
                <Fragment key={t.id}>
                  <tr>
                    <Td><span className="text-sm text-ink font-medium">{t.label}</span></Td>
                    <Td>
                      <span className="font-mono text-xs text-ink-muted break-all max-w-xs block truncate" title={t.url}>
                        {t.url.length > 50 ? `${t.url.slice(0, 50)}…` : t.url}
                      </span>
                    </Td>
                    <Td>
                      <span className="text-xs text-ink-muted">
                        {PLACEMENT_LABELS[t.token_placement]}
                        {t.token_param ? ` (${t.token_param})` : ''}
                        {t.hasToken ? ' ·  token set' : ''}
                      </span>
                    </Td>
                    <Td>
                      <span className={`text-xs font-medium ${t.active ? 'text-success' : 'text-ink-dim'}`}>
                        {t.active ? 'Active' : 'Disabled'}
                      </span>
                    </Td>
                    <Td>
                      <span className="text-xs text-ink-muted">
                        {t.last_fired_at ? new Date(t.last_fired_at).toLocaleString() : '—'}
                      </span>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-2">
                        <Button variant="secondary" onClick={() => runTest(t)}>Test</Button>
                        <Button variant="primary" disabled={!t.active} onClick={() => runFire(t)}>Fire</Button>
                        <Button variant="ghost" onClick={() => toggleActive(t)}>
                          {t.active ? 'Disable' : 'Enable'}
                        </Button>
                        <Button variant="ghost" onClick={() => showLog(t)}>Log</Button>
                        <Button variant="danger" onClick={() => remove(t)}>Delete</Button>
                      </div>
                    </Td>
                  </tr>
                  {fires[t.id] && (
                    <tr key={`${t.id}-fires`}>
                      <Td colSpan={6}>
                        <div className="py-2">
                          <FiresTable fires={fires[t.id]} />
                        </div>
                      </Td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </Table>
        </div>
      )}

      {/* Create form */}
      <div className="bg-surface-raised border border-line rounded-2xl p-6 space-y-5">
        <h3 className="text-base font-semibold text-ink">Add call trigger</h3>
        <form onSubmit={create} className="space-y-4">
          <Field label="Label">
            <Input
              required
              placeholder="e.g. Inbound lead webhook"
              value={label}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setLabel(e.target.value)}
            />
          </Field>

          <Field label="Webhook URL">
            <Input
              required
              type="url"
              value={url}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setUrl(e.target.value)}
            />
          </Field>

          <Field label="Token (write-only)">
            <Input
              type="password"
              placeholder="Leave blank to keep existing"
              value={token}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setToken(e.target.value)}
              autoComplete="new-password"
            />
          </Field>

          <Field label="Token placement">
            <select
              value={placement}
              onChange={e => setPlacement(e.target.value as TokenPlacement)}
              className={SELECT_CLS}
            >
              {(Object.entries(PLACEMENT_LABELS) as [TokenPlacement, string][]).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </Field>

          {placement !== 'bearer' && (
            <Field label={placement === 'query' ? 'Query param name' : placement === 'header' ? 'Header name' : 'Body field name'}>
              <Input
                required
                placeholder={placement === 'query' ? 'token' : placement === 'header' ? 'X-Api-Key' : 'api_key'}
                value={tokenParam}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setTokenParam(e.target.value)}
              />
            </Field>
          )}

          <Field
            label="Payload template (JSON)"
            hint="Available variables: {{name}}  {{phone}}  {{context}}"
          >
            <textarea
              required
              rows={6}
              value={template}
              onChange={e => setTemplate(e.target.value)}
              className={TEXTAREA_CLS}
              spellCheck={false}
            />
          </Field>

          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save trigger'}
          </Button>
        </form>
      </div>
    </div>
  );
}
