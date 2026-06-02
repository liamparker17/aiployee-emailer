import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { Card } from '../Card';
import { api } from '../../api';
import { useAuth } from '../../auth';

interface Sender { id: string; is_default: boolean }

interface Props {
  onReady?: (ready: boolean) => void;
}

export default function AbeReadiness({ onReady }: Props) {
  const { tenantId } = useParams<{ tenantId: string }>();
  const base = `/t/${tenantId}`;
  const { user } = useAuth();
  const isAdmin = user?.role !== 'tenant_user';

  // null = loading, true/false = resolved
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [hasDefaultSender, setHasDefaultSender] = useState<boolean | null>(null);

  // Non-admins: can't access the admin endpoint — assume ready so they see no banner
  useEffect(() => {
    if (!isAdmin) onReady?.(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    const ac = new AbortController();
    const signal = ac.signal;

    const fetchKey = api<{ config: { has_key: boolean } | null }>('/api/agent/config', { signal })
      .then(r => setHasKey(r.config?.has_key === true))
      .catch(() => setHasKey(false));

    const fetchSenders = api<{ senders: Sender[] }>('/api/senders', { signal })
      .then(r => setHasDefaultSender(r.senders.some(s => s.is_default)))
      .catch(() => setHasDefaultSender(false));

    Promise.all([fetchKey, fetchSenders]).catch(() => {/* already handled per-fetch */});

    return () => ac.abort();
  }, []);

  if (!isAdmin) return null;

  const loading = hasKey === null || hasDefaultSender === null;
  const ready = hasKey === true && hasDefaultSender === true;

  useEffect(() => {
    if (!loading) onReady?.(ready);
  }, [loading, ready, onReady]);

  // Don't flash anything until both fetches resolve
  if (loading) return null;

  // Both prerequisites met — no banner needed
  if (ready) return null;

  return (
    <Card className="border-error/40 bg-surface">
      <div className="flex items-start gap-3">
        <AlertTriangle size={18} className="text-error shrink-0 mt-0.5" />
        <div className="space-y-3 flex-1 min-w-0">
          <p className="font-heading font-semibold text-ink">
            Abe can't send updates to ABSA yet — two things to finish setup.
          </p>
          <ul className="space-y-2">
            {!hasKey && (
              <li className="flex flex-col gap-0.5 text-sm">
                <span className="text-ink-muted">Connect an OpenAI key so Abe can think.</span>
                <Link
                  to={`${base}/ai-responses`}
                  className="text-magenta hover:underline font-medium w-fit"
                >
                  Open AI settings
                </Link>
              </li>
            )}
            {!hasDefaultSender && (
              <li className="flex flex-col gap-0.5 text-sm">
                <span className="text-ink-muted">Set a default sender so Abe can send.</span>
                <Link
                  to={`${base}/senders`}
                  className="text-magenta hover:underline font-medium w-fit"
                >
                  Manage senders
                </Link>
              </li>
            )}
          </ul>
        </div>
      </div>
    </Card>
  );
}
