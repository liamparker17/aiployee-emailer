import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { Card } from '@aiployee/ui';
import { Button } from '@aiployee/ui';
import { Skeleton } from '@aiployee/ui';
import { useToast } from '@aiployee/ui';
import { api } from '@aiployee/ui';
import { useAuth } from '@aiployee/ui';
import type { AbeGoal, AbePlay } from '../../lib/abe';

interface Props { goal: AbeGoal; onChange: () => void }

export default function PendingApprovals({ goal, onChange }: Props) {
  const toast = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role !== 'tenant_user';

  const [plays, setPlays] = useState<AbePlay[] | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const load = () =>
    api<{ plays: AbePlay[] }>('/api/agent/plays')
      .then(r => setPlays(r.plays.filter(p => p.status === 'pending_approval')))
      .catch(() => { setPlays([]); toast.error("Could not load Abe's plays."); });

  useEffect(() => {
    const controller = new AbortController();
    api<{ plays: AbePlay[] }>('/api/agent/plays', { signal: controller.signal })
      .then(r => setPlays(r.plays.filter(p => p.status === 'pending_approval')))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setPlays([]);
        toast.error("Could not load Abe's plays.");
      });
    return () => controller.abort();
  }, []);

  async function approve(id: string) {
    try {
      await api(`/api/agent/plays/${id}/approve`, { method: 'POST' });
      toast.success('Approved — Abe is sending it now.');
      load();
      onChange();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Could not approve play.');
    }
  }

  async function confirmReject(id: string) {
    try {
      await api(`/api/agent/plays/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: rejectReason }),
      });
      toast.success('Rejected.');
      setRejectingId(null);
      setRejectReason('');
      load();
      onChange();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Could not reject play.');
    }
  }

  if (plays === null) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (plays.length === 0) {
    return (
      <p className="text-sm text-ink-dim">
        Nothing needs your sign-off right now.
      </p>
    );
  }

  const hasVerifiedManager =
    !!goal.line_manager_email && !!goal.line_manager_verified_at;

  return (
    <div className="space-y-4">
      {plays.map(play => (
        <Card key={play.id} className="space-y-3">
          {/* Audience + risk row */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <span className="text-sm font-semibold text-ink">
                {play.audience_snapshot.size} contact
                {play.audience_snapshot.size !== 1 ? 's' : ''}
              </span>
              <span className="ml-2 text-sm text-ink-muted">in this play</span>
            </div>
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
                play.risk_score >= 70
                  ? 'border-error/40 text-error'
                  : play.risk_score >= 40
                  ? 'border-amber-400/40 text-amber-400'
                  : 'border-success/40 text-success'
              }`}
            >
              Risk {play.risk_score}
            </span>
          </div>

          {/* Touch list */}
          <ul className="space-y-1">
            {play.touches.map(t => (
              <li key={t.index} className="flex items-start gap-2 text-sm">
                <span className="shrink-0 text-ink-dim w-14">Day {t.scheduled_offset_days}</span>
                <span className="text-ink-muted truncate">{t.subject}</span>
              </li>
            ))}
          </ul>

          {/* Manager note */}
          {hasVerifiedManager && (
            <p className="text-xs text-ink-dim">
              Abe also emailed this to{' '}
              <span className="text-ink-muted">{goal.line_manager_email}</span>{' '}
              for sign-off.
            </p>
          )}

          {/* Approve / Reject (admin only) */}
          {isAdmin && (
            <>
              {rejectingId === play.id ? (
                <div className="space-y-2 pt-1">
                  <textarea
                    rows={2}
                    value={rejectReason}
                    onChange={e => setRejectReason(e.target.value)}
                    placeholder="Reason for rejecting (optional)"
                    className="w-full rounded-lg border border-line-strong bg-surface-raised text-ink placeholder:text-ink-dim px-3 py-2 text-sm transition focus:outline-none focus:border-accent focus:ring-2 focus:ring-magenta/40 resize-none"
                  />
                  <div className="flex gap-2">
                    <Button variant="danger" onClick={() => confirmReject(play.id)}>
                      <XCircle size={15} />
                      Confirm reject
                    </Button>
                    <Button variant="ghost" onClick={() => { setRejectingId(null); setRejectReason(''); }}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2 pt-1">
                  <Button
                    variant="primary"
                    onClick={() => approve(play.id)}
                  >
                    <CheckCircle2 size={15} />
                    Approve
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => setRejectingId(play.id)}
                  >
                    <XCircle size={15} />
                    Reject
                  </Button>
                </div>
              )}
            </>
          )}
        </Card>
      ))}
    </div>
  );
}
