import { useState, useCallback } from 'react';
import { Bot } from 'lucide-react';
import { Card } from '../Card';
import { Button } from '../Button';
import AbeFeed from './AbeFeed';
import PendingApprovals from './PendingApprovals';
import ManageAbe from './ManageAbe';
import AbeReadiness from './AbeReadiness';
import AbeChat from './AbeChat';
import type { AbeGoal } from '../../lib/abe';

interface Props { goal: AbeGoal; onChange: () => void }

function statusLine(goal: AbeGoal, ready: boolean | null): string {
  if (!goal.enabled) return 'Paused';
  // ready===null means still loading — show neutral text
  if (ready === false) return 'Needs setup before his first shift';
  return 'On shift · re-engaging dormant contacts';
}

export default function AbeHome({ goal, onChange }: Props) {
  const [manageOpen, setManageOpen] = useState(false);
  const [feedKey, setFeedKey] = useState(0);
  const [readinessKey, setReadinessKey] = useState(0);
  // null = loading, true/false = resolved from AbeReadiness
  const [ready, setReady] = useState<boolean | null>(null);
  const handleReady = useCallback((r: boolean) => setReady(r), []);

  const refresh = () => { setFeedKey((k) => k + 1); setReadinessKey((k) => k + 1); onChange(); };

  return (
    <div className="space-y-6">
      {/* ── Readiness banner (renders nothing when both prereqs are met) ── */}
      <AbeReadiness key={readinessKey} onReady={handleReady} />

      {/* ── Employee header ── */}
      <Card className="flex items-center gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-magenta/15 text-magenta">
          <Bot size={26} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-lg font-heading font-semibold text-ink">Abe</p>
          <p className="text-sm text-ink-muted mt-0.5">{statusLine(goal, ready)}</p>
        </div>
        <Button
          variant="secondary"
          onClick={() => setManageOpen(true)}
        >
          Manage Abe
        </Button>
      </Card>

      {manageOpen && (
        <ManageAbe
          open
          onClose={() => setManageOpen(false)}
          goal={goal}
          onSaved={refresh}
        />
      )}

      {/* ── Talk to Abe ── */}
      <AbeChat onActed={refresh} />

      {/* ── Pending approvals (action items — shown above feed) ── */}
      <section>
        <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wide mb-3">
          Needs your sign-off
        </h2>
        <PendingApprovals goal={goal} onChange={refresh} />
      </section>

      {/* ── Work log ── */}
      <section>
        <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wide mb-3">
          Abe's work log
        </h2>
        <AbeFeed key={feedKey} />
      </section>
    </div>
  );
}
