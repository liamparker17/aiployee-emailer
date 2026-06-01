import { useState } from 'react';
import { Bot } from 'lucide-react';
import { Card } from '../Card';
import { Button } from '../Button';
import AbeFeed from './AbeFeed';
import PendingApprovals from './PendingApprovals';
import ManageAbe from './ManageAbe';
import type { AbeGoal } from '../../lib/abe';

interface Props { goal: AbeGoal; onChange: () => void }

function statusLine(goal: AbeGoal): string {
  if (!goal.enabled) return 'Paused';
  return 'On shift · re-engaging dormant contacts';
}

export default function AbeHome({ goal, onChange }: Props) {
  const [manageOpen, setManageOpen] = useState(false);

  return (
    <div className="space-y-6">
      {/* ── Employee header ── */}
      <Card className="flex items-center gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-magenta/15 text-magenta">
          <Bot size={26} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-lg font-heading font-semibold text-ink">Abe</p>
          <p className="text-sm text-ink-muted mt-0.5">{statusLine(goal)}</p>
        </div>
        <Button
          variant="secondary"
          onClick={() => setManageOpen(true)}
        >
          Manage Abe
        </Button>
      </Card>

      <ManageAbe
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        goal={goal}
        onSaved={onChange}
      />

      {/* ── Pending approvals (action items — shown above feed) ── */}
      <section>
        <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wide mb-3">
          Needs your sign-off
        </h2>
        <PendingApprovals goal={goal} onChange={onChange} />
      </section>

      {/* ── Work log ── */}
      <section>
        <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wide mb-3">
          Abe's work log
        </h2>
        <AbeFeed />
      </section>
    </div>
  );
}
