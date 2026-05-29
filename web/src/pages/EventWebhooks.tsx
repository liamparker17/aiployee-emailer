import { useEffect, useState, type FormEvent, type ChangeEvent } from 'react';
import { Webhook } from 'lucide-react';
import { api } from '../api';
import { Table, Th, Td } from '../components/Table';
import { Button } from '../components/Button';
import { Input, Field } from '../components/Input';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';
import { useToast } from '../components/Toast';

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
        title="Event webhooks"
        subtitle="Get notified when emails are sent, delivered, bounced, or marked as spam."
      />

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
