import { useEffect, useState } from 'react';
import { Sparkles, Mail, Clock, CheckCircle, XCircle, Zap, Bot } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Skeleton } from '../Skeleton';
import { EmptyState } from '../EmptyState';
import { api } from '../../api';
import type { AbeFeedEntry } from '../../lib/abe';

function kindIcon(kind: string): LucideIcon {
  switch (kind) {
    case 'play_proposed':    return Sparkles;
    case 'play_approved':    return CheckCircle;
    case 'play_rejected':    return XCircle;
    case 'play_executing':   return Zap;
    case 'play_done':        return CheckCircle;
    case 'email_sent':       return Mail;
    case 'shift_start':      return Bot;
    default:                 return Clock;
  }
}

function relativeTime(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export default function AbeFeed() {
  const [feed, setFeed] = useState<AbeFeedEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api<{ feed: AbeFeedEntry[] }>('/api/agent/feed', { signal: controller.signal })
      .then(r => setFeed(r.feed))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError('Could not load Abe\'s work log — try refreshing.');
      });
    return () => controller.abort();
  }, []);

  if (error) {
    return (
      <p className="text-sm text-ink-muted py-6 text-center">{error}</p>
    );
  }

  if (feed === null) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-5/6" />
        <Skeleton className="h-10 w-4/6" />
      </div>
    );
  }

  if (feed.length === 0) {
    return (
      <EmptyState
        icon={Sparkles}
        title="Nothing logged yet"
        description="Abe hasn't logged anything yet — he'll post here after his first shift."
      />
    );
  }

  // Reverse-chronological order
  const sorted = [...feed].sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()
  );

  return (
    <ol className="relative border-l border-line ml-3 space-y-0">
      {sorted.map((entry, i) => {
        const Icon = kindIcon(entry.kind);
        return (
          <li key={`${entry.playId}-${entry.at}-${i}`} className="mb-6 ml-6">
            <span className="absolute -left-3 flex h-6 w-6 items-center justify-center rounded-full bg-surface border border-line text-ink-muted">
              <Icon size={13} />
            </span>
            <p className="text-sm text-ink leading-snug">{entry.text}</p>
            <time className="block text-xs text-ink-dim mt-0.5">{relativeTime(entry.at)}</time>
          </li>
        );
      })}
    </ol>
  );
}
