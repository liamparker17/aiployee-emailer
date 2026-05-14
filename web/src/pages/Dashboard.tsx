import { useEffect, useState } from 'react';
import { api } from '../api';
import { Table, Th, Td } from '../components/Table';

interface Email { id: string; to_addr: string; subject: string; status: string; created_at: string }

export default function Dashboard() {
  const [emails, setEmails] = useState<Email[]>([]);
  useEffect(() => { api<{ emails: Email[] }>('/api/emails?limit=10').then(r => setEmails(r.emails)); }, []);
  const counts = emails.reduce<Record<string, number>>((acc, e) => { acc[e.status] = (acc[e.status] ?? 0) + 1; return acc; }, {});
  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-heading font-semibold">Dashboard</h1>
      <div className="grid grid-cols-4 gap-4">
        {['sent','queued','failed','bounced'].map(s => (
          <div key={s} className="border border-line rounded-lg p-4">
            <div className="text-xs uppercase text-muted">{s}</div>
            <div className="text-2xl font-semibold mt-1">{counts[s] ?? 0}</div>
          </div>
        ))}
      </div>
      <div>
        <h2 className="text-lg font-heading font-semibold mb-3">Latest emails</h2>
        <Table>
          <thead><tr><Th>Time</Th><Th>To</Th><Th>Subject</Th><Th>Status</Th></tr></thead>
          <tbody>{emails.map(e => (
            <tr key={e.id}><Td>{new Date(e.created_at).toLocaleString()}</Td><Td>{e.to_addr}</Td><Td>{e.subject}</Td><Td>{e.status}</Td></tr>
          ))}</tbody>
        </Table>
      </div>
    </div>
  );
}
