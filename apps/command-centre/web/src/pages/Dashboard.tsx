import { useEffect, useState } from 'react';
import { Inbox } from 'lucide-react';
import { api } from '@aiployee/ui';
import { PageHeader } from '@aiployee/ui';
import { Table, Th, Td } from '@aiployee/ui';
import { StatusBadge } from '@aiployee/ui';
import { EmptyState } from '@aiployee/ui';
import { Skeleton } from '@aiployee/ui';

interface Email { id: string; to_addr: string; subject: string; status: string; created_at: string }
interface Summary { sent: number; opens: number; uniqueOpens: number; clicks: number; uniqueClicks: number; bounced: number }

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

const stats = [
  { key: 'sent',    label: 'Sent',    color: 'text-success', ring: 'border-success/30' },
  { key: 'queued',  label: 'Queued',  color: 'text-cyan',    ring: 'border-cyan/30'    },
  { key: 'failed',  label: 'Failed',  color: 'text-error',   ring: 'border-error/30'   },
  { key: 'bounced', label: 'Bounced', color: 'text-violet',  ring: 'border-violet/30'  },
];

export default function Dashboard() {
  const [emails, setEmails] = useState<Email[]>([]);
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<Summary | null>(null);
  useEffect(() => {
    api<{ emails: Email[] }>('/api/emails?limit=10').then(r => { setEmails(r.emails); setLoading(false); });
    api<{ summary: Summary }>('/api/analytics/summary').then(r => setSummary(r.summary)).catch(() => {});
  }, []);
  const counts = emails.reduce<Record<string, number>>((acc, e) => { acc[e.status] = (acc[e.status] ?? 0) + 1; return acc; }, {});
  return (
    <div className="space-y-8">
      <PageHeader title="Dashboard" />
      <div className="grid grid-cols-4 gap-4">
        {stats.map(s => (
          <div key={s.key} className={`bg-surface border ${s.ring} rounded-2xl p-4`}>
            <div className="text-xs uppercase tracking-wide text-ink-dim">{s.label}</div>
            <div className={`text-3xl font-semibold mt-1 ${s.color}`}>{counts[s.key] ?? 0}</div>
          </div>
        ))}
      </div>
      {summary && (
        <div>
          <h2 className="text-lg font-heading font-semibold text-ink mb-3">Engagement</h2>
          <div className="grid grid-cols-4 gap-4">
            <div className="bg-surface border border-line rounded-2xl p-4">
              <div className="text-xs uppercase tracking-wide text-ink-dim">Delivered</div>
              <div className="text-3xl font-semibold mt-1 text-ink">{summary.sent}</div>
            </div>
            <div className="bg-surface border border-magenta/30 rounded-2xl p-4">
              <div className="text-xs uppercase tracking-wide text-ink-dim">Open rate</div>
              <div className="text-3xl font-semibold mt-1 text-magenta">{pct(summary.uniqueOpens, summary.sent)}%</div>
              <div className="text-xs text-ink-dim mt-1">{summary.uniqueOpens} unique · {summary.opens} total</div>
            </div>
            <div className="bg-surface border border-accent/30 rounded-2xl p-4">
              <div className="text-xs uppercase tracking-wide text-ink-dim">Click rate</div>
              <div className="text-3xl font-semibold mt-1 text-accent">{pct(summary.uniqueClicks, summary.sent)}%</div>
              <div className="text-xs text-ink-dim mt-1">{summary.uniqueClicks} unique · {summary.clicks} total</div>
            </div>
            <div className="bg-surface border border-error/30 rounded-2xl p-4">
              <div className="text-xs uppercase tracking-wide text-ink-dim">Bounced</div>
              <div className="text-3xl font-semibold mt-1 text-error">{summary.bounced}</div>
            </div>
          </div>
        </div>
      )}
      <div>
        <h2 className="text-lg font-heading font-semibold text-ink mb-3">Latest emails</h2>
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : !loading && emails.length === 0 ? (
          <EmptyState icon={Inbox} title="No emails yet" description="Sent emails will appear here." />
        ) : (
          <Table>
            <thead><tr><Th>Time</Th><Th>To</Th><Th>Subject</Th><Th>Status</Th></tr></thead>
            <tbody>{emails.map(e => (
              <tr key={e.id}><Td>{new Date(e.created_at).toLocaleString()}</Td><Td>{e.to_addr}</Td><Td>{e.subject}</Td><Td><StatusBadge status={e.status} /></Td></tr>
            ))}</tbody>
          </Table>
        )}
      </div>
    </div>
  );
}
