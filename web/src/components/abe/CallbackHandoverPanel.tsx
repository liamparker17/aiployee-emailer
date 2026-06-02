import { useState, useEffect, useCallback } from 'react';
import { PhoneForwarded, AlertTriangle, Pencil, XCircle } from 'lucide-react';
import { Card } from '../Card';
import { Button } from '../Button';
import { Skeleton } from '../Skeleton';
import { useToast } from '../Toast';
import { useAuth } from '../../auth';
import {
  getHandovers,
  forwardHandover,
  dismissHandover,
  patchHandover,
} from '../../lib/abe';
import type { Handover } from '../../lib/abe';

// ── Helpers ──────────────────────────────────────────────────────────────────

function urgencyChip(urgency: 'low' | 'med' | 'high') {
  const base = 'text-xs font-medium px-2 py-0.5 rounded-full border';
  if (urgency === 'high') return `${base} border-error/40 text-error`;
  if (urgency === 'med') return `${base} border-amber-400/40 text-amber-400`;
  return `${base} border-success/40 text-success`;
}

function humanField(field: string): string {
  if (field === 'caller_phone') return 'phone';
  if (field === 'caller_name') return 'name';
  if (field === 'account_ref') return 'account ref';
  if (field === 'reason_category') return 'reason';
  return field.replace(/_/g, ' ');
}

function timeWaiting(createdAt: string): string {
  const ms = Date.now() - new Date(createdAt).getTime();
  const totalMins = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours === 0) return `waiting ${mins}m`;
  return `waiting ${hours}h ${mins}m`;
}

// ── Single handover card ──────────────────────────────────────────────────────

interface HandoverCardProps {
  handover: Handover;
  onReload: () => void;
}

function HandoverCard({ handover, onReload }: HandoverCardProps) {
  const toast = useToast();

  const [dismissing, setDismissing] = useState(false);
  const [dismissReason, setDismissReason] = useState('');
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(handover.caller_name ?? '');
  const [editPhone, setEditPhone] = useState(handover.caller_phone ?? '');
  const [editAccount, setEditAccount] = useState(handover.account_ref ?? '');
  const [editUrgency, setEditUrgency] = useState<'low' | 'med' | 'high'>(handover.urgency);
  const [saving, setSaving] = useState(false);
  const [forwarding, setForwarding] = useState(false);

  const inputCls =
    'w-full rounded-lg border border-line-strong bg-surface-raised text-ink placeholder:text-ink-dim px-3 py-2 text-sm transition focus:outline-none focus:border-accent focus:ring-2 focus:ring-magenta/40';

  function resetEdit() {
    setEditing(false);
    setEditName(handover.caller_name ?? '');
    setEditPhone(handover.caller_phone ?? '');
    setEditAccount(handover.account_ref ?? '');
    setEditUrgency(handover.urgency);
  }

  async function handleForward() {
    setForwarding(true);
    try {
      await forwardHandover(handover.id);
      toast.success('Forwarded to ABSA.');
      onReload();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not forward.';
      if (msg.includes('no_recipients')) {
        toast.error('Add an ABSA recipient in Line Reporting settings first.');
      } else {
        toast.error(msg);
      }
    } finally {
      setForwarding(false);
    }
  }

  async function handleDismiss() {
    try {
      await dismissHandover(handover.id, dismissReason);
      toast.success('Callback dismissed.');
      setDismissing(false);
      setDismissReason('');
      onReload();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Could not dismiss.');
    }
  }

  async function handleSaveEdit() {
    setSaving(true);
    try {
      await patchHandover(handover.id, {
        caller_name: editName.trim() || undefined,
        caller_phone: editPhone.trim() || undefined,
        account_ref: editAccount.trim() || undefined,
        urgency: editUrgency,
      });
      toast.success('Caller details updated.');
      setEditing(false);
      onReload();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  }

  const isOverSla = (Date.now() - new Date(handover.created_at).getTime()) > 2 * 3600 * 1000;

  return (
    <Card className="space-y-0 p-0 overflow-hidden">
      {/* ── Caller identity ── */}
      <div className="px-5 py-4 space-y-3 border-b border-line">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={urgencyChip(handover.urgency)}>{handover.urgency}</span>
            <span className="text-xs font-medium uppercase tracking-wide text-ink-dim">
              {handover.reason_category}
            </span>
            {handover.vulnerable && (
              <span className="text-xs font-medium px-2 py-0.5 rounded-full border border-amber-400/40 text-amber-400">
                ⚠ Vulnerable
              </span>
            )}
            {handover.repeat_of && (
              <span className="text-xs font-medium px-2 py-0.5 rounded-full border border-line-strong text-ink-muted">
                ⟳ Repeat caller
              </span>
            )}
          </div>
          <span className="text-xs text-ink-dim shrink-0">{timeWaiting(handover.created_at)}</span>
        </div>

        {editing ? (
          <div className="space-y-3">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-ink-muted">Caller name</span>
              <input
                value={editName}
                onChange={e => setEditName(e.target.value)}
                placeholder="e.g. Jane Smith"
                className={inputCls}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-ink-muted">Caller phone</span>
              <input
                value={editPhone}
                onChange={e => setEditPhone(e.target.value)}
                placeholder="e.g. +27 82 123 4567"
                className={inputCls}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-ink-muted">Account ref</span>
              <input
                value={editAccount}
                onChange={e => setEditAccount(e.target.value)}
                placeholder="e.g. ACC-00123"
                className={inputCls}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-ink-muted">Urgency</span>
              <select
                value={editUrgency}
                onChange={e => setEditUrgency(e.target.value as 'low' | 'med' | 'high')}
                className={inputCls}
              >
                <option value="low">low</option>
                <option value="med">med</option>
                <option value="high">high</option>
              </select>
            </label>
            <div className="flex gap-2">
              <Button variant="primary" onClick={handleSaveEdit} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Button variant="ghost" onClick={resetEdit} disabled={saving}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <span className="text-ink-dim">Name</span>
            <span className={handover.caller_name ? 'text-ink' : 'text-ink-dim italic'}>
              {handover.caller_name ?? '— not captured —'}
            </span>
            <span className="text-ink-dim">Phone</span>
            <span className={handover.caller_phone ? 'text-ink' : 'text-ink-dim italic'}>
              {handover.caller_phone ?? '— not captured —'}
            </span>
            <span className="text-ink-dim">Account</span>
            <span className={handover.account_ref ? 'text-ink' : 'text-ink-dim italic'}>
              {handover.account_ref ?? '— not captured —'}
            </span>
          </div>
        )}

        {/* Missing-field chips */}
        {handover.missing_fields.length > 0 && !editing && (
          <div className="flex flex-wrap gap-1.5">
            {handover.missing_fields.map(f => (
              <span
                key={f}
                className="text-xs px-2 py-0.5 rounded-full border border-error/30 text-error/80"
              >
                missing: {humanField(f)}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ── Summary & recommended action ── */}
      <div className="px-5 py-4 space-y-2 border-b border-line">
        <p className="text-sm text-ink leading-relaxed">{handover.summary}</p>
        {handover.recommended_action && (
          <p className="text-sm text-ink-muted">
            <span className="font-medium text-ink">Recommended: </span>
            {handover.recommended_action}
          </p>
        )}
      </div>

      {/* ── Actions ── */}
      <div className="px-5 py-4">
        {dismissing ? (
          <div className="space-y-2">
            <textarea
              rows={2}
              value={dismissReason}
              onChange={e => setDismissReason(e.target.value)}
              placeholder="Reason for dismissing (optional)"
              className="w-full rounded-lg border border-line-strong bg-surface-raised text-ink placeholder:text-ink-dim px-3 py-2 text-sm transition focus:outline-none focus:border-accent focus:ring-2 focus:ring-magenta/40 resize-none"
            />
            <div className="flex gap-2">
              <Button variant="danger" onClick={handleDismiss}>
                <XCircle size={15} />
                Confirm dismiss
              </Button>
              <Button variant="ghost" onClick={() => { setDismissing(false); setDismissReason(''); }}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2 flex-wrap">
            <Button variant="primary" onClick={handleForward} disabled={forwarding}>
              <PhoneForwarded size={15} />
              {forwarding ? 'Forwarding…' : 'Forward to ABSA'}
            </Button>
            {!editing && (
              <Button variant="ghost" onClick={() => setEditing(true)}>
                <Pencil size={15} />
                Edit
              </Button>
            )}
            <Button variant="danger" onClick={() => setDismissing(true)}>
              <XCircle size={15} />
              Dismiss
            </Button>
          </div>
        )}
      </div>

      {/* SLA per-card indicator */}
      {isOverSla && (
        <div className="px-5 pb-3 -mt-1">
          <span className="text-xs text-error flex items-center gap-1">
            <AlertTriangle size={12} />
            Waiting over 2 hours
          </span>
        </div>
      )}
    </Card>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function CallbackHandoverPanel() {
  const { user, loading } = useAuth();
  const toast = useToast();
  const isAdmin = !loading && user?.role !== 'tenant_user';

  const [handovers, setHandovers] = useState<Handover[] | null>(null);

  const load = useCallback(() => {
    const controller = new AbortController();
    getHandovers('pending')
      .then(r => setHandovers(r.handovers))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        toast.error('Could not load callback queue.');
        setHandovers([]);
      });
    return controller;
  }, [toast]);

  useEffect(() => {
    if (!isAdmin) return;
    const controller = load();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  if (!isAdmin) return null;

  const overSlaCount = (handovers ?? []).filter(
    h => (Date.now() - new Date(h.created_at).getTime()) > 2 * 3600 * 1000,
  ).length;

  function handleReload() {
    setHandovers(null);
    load();
  }

  return (
    <section>
      <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wide mb-3">
        Callbacks to forward to ABSA
      </h2>

      {/* SLA banner */}
      {handovers !== null && overSlaCount > 0 && (
        <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg border border-error/40 bg-error/5 text-error text-sm">
          <AlertTriangle size={15} className="shrink-0" />
          <span>
            {overSlaCount} caller{overSlaCount > 1 ? 's' : ''} waiting &gt; 2h
          </span>
        </div>
      )}

      {handovers === null ? (
        <div className="space-y-3">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : handovers.length === 0 ? (
        <p className="text-sm text-ink-dim">
          No callbacks waiting — Abe will queue them as calls come in.
        </p>
      ) : (
        <div className="space-y-4">
          {handovers.map(h => (
            <HandoverCard key={h.id} handover={h} onReload={handleReload} />
          ))}
        </div>
      )}
    </section>
  );
}
