import { useEffect, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useParams } from 'react-router-dom';
import { api } from '@aiployee/ui';
import { Table, Th, Td } from '@aiployee/ui';
import { Button } from '@aiployee/ui';
import { Modal } from '@aiployee/ui';
import { PageHeader } from '@aiployee/ui';
import { EmptyState } from '@aiployee/ui';
import { Skeleton } from '@aiployee/ui';
import { StatusBadge } from '@aiployee/ui';
import { Spinner } from '@aiployee/ui';
import { useToast } from '@aiployee/ui';
import { useAuth } from '@aiployee/ui';
import type { Thread, Action } from '../lib/inbox';

const ALL_STAGES = [
  'new_reply', 'needs_triage', 'needs_human_reply', 'draft_ready',
  'awaiting_customer', 'follow_up_due', 'escalated', 'converted',
  'lost', 'closed', 'unsubscribed',
] as const;

const selectCls = 'rounded-lg border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent disabled:opacity-50';

interface Contact { id: string; email: string; name: string | null }
interface Campaign { id: string; name: string }

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString(); } catch { return iso; }
}

export default function Conversations() {
  const toast = useToast();
  const { user } = useAuth();
  const { tenantId } = useParams<{ tenantId: string }>();
  const navigate = useNavigate();

  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(true);
  const [stageFilter, setStageFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [contactMap, setContactMap] = useState<Map<string, string>>(new Map());
  const [campaignMap, setCampaignMap] = useState<Map<string, string>>(new Map());

  // Detail modal
  const [detailThread, setDetailThread] = useState<Thread | null>(null);
  const [detailActions, setDetailActions] = useState<Action[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadThreads = () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (stageFilter) params.set('stage', stageFilter);
    if (statusFilter) params.set('status', statusFilter);
    params.set('limit', '100');
    api<{ threads: Thread[] }>(`/api/agent/inbox/threads?${params}`)
      .then(r => { setThreads(r.threads); setLoading(false); })
      .catch(err => { toast.error(err.message); setLoading(false); });
  };

  useEffect(() => {
    api<{ contacts: Contact[] }>('/api/contacts')
      .then(r => {
        const m = new Map<string, string>();
        r.contacts.forEach(c => m.set(c.id, c.email));
        setContactMap(m);
      })
      .catch(() => {});
    api<{ campaigns: Campaign[] }>('/api/campaigns')
      .then(r => {
        const m = new Map<string, string>();
        r.campaigns.forEach(c => m.set(c.id, c.name));
        setCampaignMap(m);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadThreads();
  }, [stageFilter, statusFilter]);

  async function openDetail(thread: Thread) {
    setDetailThread(thread);
    setDetailActions([]);
    setDetailLoading(true);
    try {
      const r = await api<{ thread: Thread; actions: Action[] }>(`/api/agent/inbox/threads/${thread.id}`);
      setDetailThread(r.thread);
      setDetailActions(r.actions);
    } catch (err: unknown) {
      toast.error((err as Error).message);
    } finally {
      setDetailLoading(false);
    }
  }

  if (user?.role === 'tenant_user') {
    return (
      <div className="flex items-center justify-center py-32">
        <p className="text-ink-muted text-sm">You don't have permission to view this page.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Conversations"
        subtitle="Every reply thread Abe is tracking — stage, intent, sentiment and what to do next."
      />

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <select
          className={selectCls}
          value={stageFilter}
          onChange={e => setStageFilter(e.target.value)}
          disabled={loading}
          aria-label="Filter by stage"
        >
          <option value="">All stages</option>
          {ALL_STAGES.map(s => (
            <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
          ))}
        </select>
        <select
          className={selectCls}
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          disabled={loading}
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="closed">Closed</option>
        </select>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map(i => <Skeleton key={i} className="h-10" />)}
        </div>
      ) : threads.length === 0 ? (
        <EmptyState
          icon={MessageCircle}
          title="No conversations yet"
          description="Conversations appear here as customers reply and Abe analyses them."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Contact</Th>
              <Th>Campaign</Th>
              <Th>Stage</Th>
              <Th>Intent</Th>
              <Th>Sentiment</Th>
              <Th>Lead</Th>
              <Th>Urgency</Th>
              <Th>Next action</Th>
              <Th>Due</Th>
            </tr>
          </thead>
          <tbody>
            {threads.map(t => (
              <tr
                key={t.id}
                className="cursor-pointer hover:bg-surface/50 transition"
                onClick={() => openDetail(t)}
              >
                <Td className="text-ink">
                  {t.contact_id ? (contactMap.get(t.contact_id) ?? t.contact_id) : '—'}
                </Td>
                <Td className="text-ink-muted">
                  {t.campaign_id ? (campaignMap.get(t.campaign_id) ?? t.campaign_id) : '—'}
                </Td>
                <Td>
                  <StatusBadge status={t.stage.replace(/_/g, ' ')} />
                </Td>
                <Td className="text-ink-dim max-w-[140px] truncate">{t.intent ?? '—'}</Td>
                <Td className="text-ink-dim capitalize">{t.sentiment ?? '—'}</Td>
                <Td className="text-ink-dim">{t.lead_score !== null ? t.lead_score : '—'}</Td>
                <Td className="text-ink-dim capitalize">{t.urgency ?? '—'}</Td>
                <Td className="text-ink-dim max-w-[160px] truncate">{t.next_action ?? '—'}</Td>
                <Td className="text-ink-dim">{fmtDate(t.next_action_due_at)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {/* Detail modal */}
      <Modal
        open={!!detailThread}
        onClose={() => setDetailThread(null)}
        title="Conversation"
      >
        {detailThread && (
          <div className="space-y-4">
            {detailLoading ? (
              <div className="flex justify-center py-8">
                <Spinner size={24} />
              </div>
            ) : (
              <>
                {/* Thread fields */}
                <div className="grid grid-cols-2 gap-2 text-sm">
                  {[
                    ['Stage', detailThread.stage.replace(/_/g, ' ')],
                    ['Status', detailThread.status],
                    ['Intent', detailThread.intent ?? '—'],
                    ['Sentiment', detailThread.sentiment ?? '—'],
                    ['Urgency', detailThread.urgency ?? '—'],
                    ['Lead score', detailThread.lead_score !== null ? String(detailThread.lead_score) : '—'],
                    ['Objection', detailThread.objection_type ?? '—'],
                    ['Commercial value', detailThread.commercial_value ?? '—'],
                    ['Next action', detailThread.next_action ?? '—'],
                    ['Confidence', detailThread.confidence !== null ? `${Math.round(detailThread.confidence * 100)}%` : '—'],
                  ].map(([label, value]) => (
                    <div key={label} className="bg-surface-raised border border-line rounded-lg p-2">
                      <div className="text-[10px] uppercase tracking-wide text-ink-dim">{label}</div>
                      <div className="text-sm text-ink-muted mt-0.5 capitalize truncate">{value}</div>
                    </div>
                  ))}
                </div>

                {/* Actions list */}
                {detailActions.length > 0 && (
                  <div>
                    <p className="text-xs uppercase tracking-wide text-ink-dim mb-2">Proposed actions</p>
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {detailActions.map(a => (
                        <div key={a.id} className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm">
                          <span className="text-ink truncate flex-1">{a.title}</span>
                          <span className="text-xs text-ink-dim shrink-0">{a.action_type.replace(/_/g, ' ')}</span>
                          <StatusBadge status={a.status} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2 border-t border-line">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setDetailThread(null);
                      navigate(`/t/${tenantId}/approvals`);
                    }}
                  >
                    Go to Approvals
                  </Button>
                  <Button variant="secondary" onClick={() => setDetailThread(null)}>
                    Close
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
