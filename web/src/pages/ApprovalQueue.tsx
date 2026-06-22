import { useEffect, useState } from 'react';
import { Inbox } from 'lucide-react';
import { api } from '@aiployee/ui';
import { Card } from '@aiployee/ui';
import { Button } from '@aiployee/ui';
import { Input, Field } from '@aiployee/ui';
import { Modal } from '@aiployee/ui';
import { PageHeader } from '@aiployee/ui';
import { EmptyState } from '@aiployee/ui';
import { Skeleton, Spinner } from '@aiployee/ui';
import { StatusBadge } from '@aiployee/ui';
import { useToast } from '@aiployee/ui';
import { useAuth } from '@aiployee/ui';
import type { Action } from '../lib/inbox';

interface Contact { id: string; email: string; name: string | null }
interface Campaign { id: string; name: string }

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

function riskChip(risk: Action['risk_level']) {
  const styles: Record<string, string> = {
    low: 'bg-cyan/15 text-cyan border-cyan/30',
    medium: 'bg-violet/15 text-violet border-violet/30',
    high: 'bg-error/15 text-error border-error/30',
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize ${styles[risk] ?? ''}`}>
      {risk} risk
    </span>
  );
}

export default function ApprovalQueue() {
  const toast = useToast();
  const { user } = useAuth();

  const [actions, setActions] = useState<Action[]>([]);
  const [loading, setLoading] = useState(true);
  const [contactMap, setContactMap] = useState<Map<string, string>>(new Map());
  const [campaignMap, setCampaignMap] = useState<Map<string, string>>(new Map());
  const [busyId, setBusyId] = useState<string | null>(null);

  // Edit modal state
  const [editAction, setEditAction] = useState<Action | null>(null);
  const [editSubject, setEditSubject] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  // Snooze modal state
  const [snoozeAction, setSnoozeAction] = useState<Action | null>(null);
  const [snoozeUntil, setSnoozeUntil] = useState('');
  const [snoozeSaving, setSnoozeSaving] = useState(false);

  const load = () => {
    setLoading(true);
    api<{ actions: Action[] }>('/api/agent/inbox/actions?status=pending&limit=50')
      .then(r => { setActions(r.actions); setLoading(false); })
      .catch(err => { toast.error(err.message); setLoading(false); });
  };

  useEffect(() => {
    load();
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

  if (user?.role === 'tenant_user') {
    return (
      <div className="flex items-center justify-center py-32">
        <p className="text-ink-muted text-sm">You don't have permission to view this page.</p>
      </div>
    );
  }

  async function handleApprove(action: Action) {
    const contactEmail = action.contact_id ? (contactMap.get(action.contact_id) ?? action.contact_id) : 'this contact';
    if (action.action_type === 'send_reply') {
      if (!confirm(`This will queue and send a reply to ${contactEmail}. Approve?`)) return;
    }
    setBusyId(action.id);
    try {
      await api(`/api/agent/inbox/actions/${action.id}/approve`, { method: 'POST' });
      setActions(prev => prev.filter(a => a.id !== action.id));
      if (action.action_type === 'send_reply') {
        toast.success('Reply queued — email will be sent shortly.');
      } else {
        toast.success('Action approved.');
      }
    } catch (err: unknown) {
      toast.error((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(action: Action) {
    setBusyId(action.id);
    try {
      await api(`/api/agent/inbox/actions/${action.id}/reject`, { method: 'POST' });
      setActions(prev => prev.filter(a => a.id !== action.id));
      toast.success('Action rejected.');
    } catch (err: unknown) {
      toast.error((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  function openEdit(action: Action) {
    const payload = action.edited_payload ?? {};
    setEditSubject(payload.subject ?? action.draft_subject ?? '');
    setEditBody(payload.body ?? action.draft_body ?? '');
    setEditAction(action);
  }

  async function handleEditSave() {
    if (!editAction) return;
    setEditSaving(true);
    try {
      const updated = await api<{ action: Action }>(`/api/agent/inbox/actions/${editAction.id}/edit`, {
        method: 'POST',
        body: JSON.stringify({ subject: editSubject, body: editBody }),
      });
      setActions(prev => prev.map(a => a.id === editAction.id ? updated.action : a));
      toast.success('Draft updated.');
      setEditAction(null);
    } catch (err: unknown) {
      toast.error((err as Error).message);
    } finally {
      setEditSaving(false);
    }
  }

  function openSnooze(action: Action) {
    // Default snooze: tomorrow at 9am local
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    // datetime-local format: YYYY-MM-DDTHH:MM
    const pad = (n: number) => String(n).padStart(2, '0');
    const local = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T${pad(tomorrow.getHours())}:${pad(tomorrow.getMinutes())}`;
    setSnoozeUntil(local);
    setSnoozeAction(action);
  }

  async function handleSnoozeSave() {
    if (!snoozeAction || !snoozeUntil) return;
    setSnoozeSaving(true);
    try {
      await api(`/api/agent/inbox/actions/${snoozeAction.id}/snooze`, {
        method: 'POST',
        body: JSON.stringify({ until: new Date(snoozeUntil).toISOString() }),
      });
      setActions(prev => prev.filter(a => a.id !== snoozeAction.id));
      toast.success('Action snoozed.');
      setSnoozeAction(null);
    } catch (err: unknown) {
      toast.error((err as Error).message);
    } finally {
      setSnoozeSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Approval Queue"
        subtitle="Actions Abe has proposed — review, edit, and approve or reject them here. Approving a send_reply queues a real email."
      />

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-24" />)}
        </div>
      ) : actions.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="Nothing waiting for approval"
          description="As replies come in and Abe proposes actions, they'll appear here for you to approve, edit, or reject."
        />
      ) : (
        <div className="space-y-3">
          {actions.map(action => {
            const busy = busyId === action.id;
            const contactEmail = action.contact_id ? (contactMap.get(action.contact_id) ?? action.contact_id) : null;
            const campaignName = action.campaign_id ? (campaignMap.get(action.campaign_id) ?? action.campaign_id) : null;
            const draftSubject = action.edited_payload?.subject ?? action.draft_subject;
            const draftBody = action.edited_payload?.body ?? action.draft_body;

            return (
              <Card key={action.id}>
                <div className="flex flex-col gap-3">
                  {/* Header row: type badge, risk chip, confidence */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <StatusBadge status={action.action_type.replace(/_/g, ' ')} />
                    {riskChip(action.risk_level)}
                    {action.confidence !== null && (
                      <span className="text-xs text-ink-dim">
                        {Math.round(action.confidence * 100)}% confidence
                      </span>
                    )}
                    <span className="ml-auto text-xs text-ink-dim">
                      {new Date(action.created_at).toLocaleString()}
                    </span>
                  </div>

                  {/* Title + reason */}
                  <div>
                    <p className="text-sm font-medium text-ink">{action.title}</p>
                    {action.reason && (
                      <p className="text-xs text-ink-muted mt-0.5">{action.reason}</p>
                    )}
                  </div>

                  {/* Contact + campaign */}
                  {(contactEmail || campaignName) && (
                    <div className="flex items-center gap-2 text-xs text-ink-dim">
                      {contactEmail && <span>{contactEmail}</span>}
                      {contactEmail && campaignName && <span>·</span>}
                      {campaignName && <span>{campaignName}</span>}
                    </div>
                  )}

                  {/* Draft preview for send_reply */}
                  {action.action_type === 'send_reply' && (draftSubject || draftBody) && (
                    <div className="rounded-lg border border-line bg-surface-raised p-3 space-y-1.5 max-h-40 overflow-y-auto">
                      {draftSubject && (
                        <p className="text-xs font-medium text-ink-muted">
                          <span className="text-ink-dim mr-1">Subject:</span>
                          {draftSubject}
                        </p>
                      )}
                      {draftBody && (
                        <p className="text-xs text-ink-dim whitespace-pre-wrap leading-relaxed">
                          {stripTags(draftBody)}
                        </p>
                      )}
                    </div>
                  )}

                  {/* Action buttons */}
                  <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-line">
                    <Button
                      onClick={() => handleApprove(action)}
                      disabled={busy}
                    >
                      {busy && busyId === action.id ? <Spinner size={14} /> : null}
                      Approve
                    </Button>
                    {action.action_type === 'send_reply' && (
                      <Button
                        variant="ghost"
                        onClick={() => openEdit(action)}
                        disabled={busy}
                      >
                        Edit
                      </Button>
                    )}
                    <Button
                      variant="danger"
                      onClick={() => handleReject(action)}
                      disabled={busy}
                    >
                      Reject
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => openSnooze(action)}
                      disabled={busy}
                    >
                      Snooze
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Edit modal */}
      <Modal
        open={!!editAction}
        onClose={() => { if (!editSaving) setEditAction(null); }}
        title="Edit draft"
      >
        {editAction && (
          <div className="space-y-4">
            <Field label="Subject">
              <Input
                value={editSubject}
                onChange={e => setEditSubject(e.target.value)}
                placeholder="Subject line"
              />
            </Field>
            <Field label="Body">
              <textarea
                className="w-full rounded-lg border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent min-h-[160px] resize-y"
                value={editBody}
                onChange={e => setEditBody(e.target.value)}
                placeholder="Reply body…"
              />
            </Field>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setEditAction(null)} disabled={editSaving}>
                Cancel
              </Button>
              <Button onClick={handleEditSave} disabled={editSaving}>
                {editSaving ? <Spinner size={14} /> : null}
                Save changes
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Snooze modal */}
      <Modal
        open={!!snoozeAction}
        onClose={() => { if (!snoozeSaving) setSnoozeAction(null); }}
        title="Snooze action"
      >
        {snoozeAction && (
          <div className="space-y-4">
            <p className="text-sm text-ink-muted">Snooze "{snoozeAction.title}" until:</p>
            <Field label="Snooze until">
              <Input
                type="datetime-local"
                value={snoozeUntil}
                onChange={e => setSnoozeUntil(e.target.value)}
              />
            </Field>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setSnoozeAction(null)} disabled={snoozeSaving}>
                Cancel
              </Button>
              <Button onClick={handleSnoozeSave} disabled={snoozeSaving || !snoozeUntil}>
                {snoozeSaving ? <Spinner size={14} /> : null}
                Snooze
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

