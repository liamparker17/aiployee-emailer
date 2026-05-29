import { useEffect, useState } from 'react';
import { Inbox } from 'lucide-react';
import { api } from '../api';
import { PageHeader } from '../components/PageHeader';
import { Table, Th, Td } from '../components/Table';
import { StatusBadge } from '../components/StatusBadge';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';

interface Email { id: string; to_addr: string; subject: string; status: string; created_at: string }

const stats = [
  { key: 'sent',    label: 'Sent',    color: 'text-success', ring: 'border-success/30' },
  { key: 'queued',  label: 'Queued',  color: 'text-cyan',    ring: 'border-cyan/30'    },
  { key: 'failed',  label: 'Failed',  color: 'text-error',   ring: 'border-error/30'   },
  { key: 'bounced', label: 'Bounced', color: 'text-violet',  ring: 'border-violet/30'  },
];

export default function Dashboard() {
  const [emails, setEmails] = useState<Email[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { api<{ emails: Email[] }>('/api/emails?limit=10').then(r => { setEmails(r.emails); setLoading(false); }); }, []);
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
