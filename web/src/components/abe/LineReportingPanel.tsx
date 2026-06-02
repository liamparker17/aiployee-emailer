import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight, CheckCircle2, XCircle, Pencil } from 'lucide-react';
import { Card } from '../Card';
import { Button } from '../Button';
import { Skeleton } from '../Skeleton';
import { useToast } from '../Toast';
import { useAuth } from '../../auth';
import {
  getLineReports,
  approveLineReport,
  rejectLineReport,
  patchLineReport,
} from '../../lib/abe';
import type { LineReport, Advisory } from '../../lib/abe';

// ── Helpers ──────────────────────────────────────────────────────────────────

function urgencyChip(urgency: 'low' | 'med' | 'high') {
  const base = 'text-xs font-medium px-2 py-0.5 rounded-full border';
  if (urgency === 'high') return `${base} border-error/40 text-error`;
  if (urgency === 'med') return `${base} border-amber-400/40 text-amber-400`;
  return `${base} border-success/40 text-success`;
}

function metricsSummary(metrics: unknown): string {
  if (!metrics || typeof metrics !== 'object') return '';
  const m = metrics as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof m.total === 'number') parts.push(`${m.total} total`);
  // Digest metrics carry { byCategory: { [name]: count } }; show the top few.
  if (m.byCategory && typeof m.byCategory === 'object') {
    const cats = Object.entries(m.byCategory as Record<string, number>)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, count]) => `${name} (${count})`);
    if (cats.length) parts.push(`top: ${cats.join(', ')}`);
  }
  return parts.join(' · ');
}

// ── Collapsible block ─────────────────────────────────────────────────────────

function Collapsible({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-line rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 w-full px-3 py-2 text-sm text-ink-muted hover:bg-surface-raised transition-colors"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="font-medium">{label}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 text-sm text-ink-muted border-t border-line">
          {children}
        </div>
      )}
    </div>
  );
}

// ── Single report card ────────────────────────────────────────────────────────

interface ReportCardProps {
  report: LineReport;
  onReload: () => void;
}

function ReportCard({ report, onReload }: ReportCardProps) {
  const toast = useToast();
  const { advisory } = report;

  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [editing, setEditing] = useState(false);
  const [editSubject, setEditSubject] = useState(report.subject);
  const [editBody, setEditBody] = useState(report.body);
  const [editAdvisory, setEditAdvisory] = useState<Advisory>(report.advisory);
  // talking points edited as newline-separated text, split on save
  const [editTalkingPoints, setEditTalkingPoints] = useState(
    report.advisory.draft_comms.talking_points.join('\n'),
  );
  const [saving, setSaving] = useState(false);

  const inputCls =
    'w-full rounded-lg border border-line-strong bg-surface-raised text-ink placeholder:text-ink-dim px-3 py-2 text-sm transition focus:outline-none focus:border-accent focus:ring-2 focus:ring-magenta/40';

  function resetEdit() {
    setEditing(false);
    setEditSubject(report.subject);
    setEditBody(report.body);
    setEditAdvisory(report.advisory);
    setEditTalkingPoints(report.advisory.draft_comms.talking_points.join('\n'));
  }

  function updateAction(i: number, patch: Partial<Advisory['recommended_actions'][number]>) {
    setEditAdvisory(a => ({
      ...a,
      recommended_actions: a.recommended_actions.map((row, idx) => (idx === i ? { ...row, ...patch } : row)),
    }));
  }
  function addAction() {
    setEditAdvisory(a => ({
      ...a,
      recommended_actions: [...a.recommended_actions, { action: '', owner: '', urgency: 'med' }],
    }));
  }
  function removeAction(i: number) {
    setEditAdvisory(a => ({
      ...a,
      recommended_actions: a.recommended_actions.filter((_, idx) => idx !== i),
    }));
  }
  function updateComms(patch: Partial<Advisory['draft_comms']>) {
    setEditAdvisory(a => ({ ...a, draft_comms: { ...a.draft_comms, ...patch } }));
  }

  async function handleApprove() {
    try {
      await approveLineReport(report.id);
      toast.success('Report approved — Abe is sending it now.');
      onReload();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Could not approve report.');
    }
  }

  async function handleReject() {
    try {
      await rejectLineReport(report.id, rejectReason);
      toast.success('Report rejected.');
      setRejectingId(null);
      setRejectReason('');
      onReload();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Could not reject report.');
    }
  }

  async function handleSaveEdit() {
    setSaving(true);
    try {
      const advisory: Advisory = {
        ...editAdvisory,
        root_cause_hypothesis: editAdvisory.root_cause_hypothesis?.trim() || null,
        recommended_actions: editAdvisory.recommended_actions
          .filter(a => a.action.trim())
          .map(a => ({ action: a.action.trim(), owner: a.owner.trim() || 'Unassigned', urgency: a.urgency })),
        draft_comms: {
          ...editAdvisory.draft_comms,
          talking_points: editTalkingPoints.split('\n').map(s => s.trim()).filter(Boolean),
        },
      };
      await patchLineReport(report.id, { subject: editSubject, body: editBody, advisory });
      toast.success('Report updated.');
      setEditing(false);
      onReload();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  }

  const metricsText = metricsSummary(report.metrics);
  const bodyPreview = report.body.length > 200 ? report.body.slice(0, 200) + '…' : report.body;

  return (
    <Card className="space-y-0 p-0 overflow-hidden">
      {/* ── Diagnosis half ── */}
      <div className="px-5 py-4 space-y-3 border-b border-line">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-ink-dim">Diagnosis</span>
          <span className="text-xs text-ink-dim">·</span>
          <span className="text-xs text-ink-dim capitalize">{report.report_type}</span>
        </div>

        {editing ? (
          <div className="space-y-3">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-ink-muted">Subject</span>
              <input
                value={editSubject}
                onChange={e => setEditSubject(e.target.value)}
                className={`${inputCls} font-semibold`}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-ink-muted">Body (what's sent to ABSA)</span>
              <textarea
                rows={5}
                value={editBody}
                onChange={e => setEditBody(e.target.value)}
                className={`${inputCls} resize-y`}
              />
            </label>

            {/* ── Advisory editor ── */}
            <div className="pt-1 space-y-3 border-t border-line">
              <span className="text-xs font-medium uppercase tracking-wide text-ink-dim">Advisory</span>

              <label className="block space-y-1">
                <span className="text-xs font-medium text-ink-muted">Root-cause hypothesis</span>
                <input
                  value={editAdvisory.root_cause_hypothesis ?? ''}
                  onChange={e => setEditAdvisory(a => ({ ...a, root_cause_hypothesis: e.target.value }))}
                  placeholder="Likely cause (stated as a hypothesis)"
                  className={inputCls}
                />
              </label>

              <div className="space-y-2">
                <span className="text-xs font-medium text-ink-muted">Recommended actions</span>
                {editAdvisory.recommended_actions.map((a, i) => (
                  <div key={i} className="flex flex-wrap gap-2 items-start">
                    <input
                      value={a.action}
                      onChange={e => updateAction(i, { action: e.target.value })}
                      placeholder="Action"
                      className={`${inputCls} flex-1 min-w-[8rem]`}
                    />
                    <input
                      value={a.owner}
                      onChange={e => updateAction(i, { owner: e.target.value })}
                      placeholder="Owner"
                      className={`${inputCls} w-28`}
                    />
                    <select
                      value={a.urgency}
                      onChange={e => updateAction(i, { urgency: e.target.value as Advisory['recommended_actions'][number]['urgency'] })}
                      className={`${inputCls} w-24`}
                    >
                      <option value="low">low</option>
                      <option value="med">med</option>
                      <option value="high">high</option>
                    </select>
                    <Button variant="ghost" onClick={() => removeAction(i)} aria-label="Remove action">
                      Remove
                    </Button>
                  </div>
                ))}
                <Button variant="ghost" onClick={addAction}>+ Add action</Button>
              </div>

              <label className="block space-y-1">
                <span className="text-xs font-medium text-ink-muted">Draft customer message</span>
                <textarea
                  rows={3}
                  value={editAdvisory.draft_comms.customer_message}
                  onChange={e => updateComms({ customer_message: e.target.value })}
                  className={`${inputCls} resize-y`}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-ink-muted">Internal / ABSA note</span>
                <textarea
                  rows={3}
                  value={editAdvisory.draft_comms.internal_note}
                  onChange={e => updateComms({ internal_note: e.target.value })}
                  className={`${inputCls} resize-y`}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-ink-muted">Talking points (one per line)</span>
                <textarea
                  rows={3}
                  value={editTalkingPoints}
                  onChange={e => setEditTalkingPoints(e.target.value)}
                  className={`${inputCls} resize-y`}
                />
              </label>
            </div>

            <div className="flex gap-2">
              <Button variant="primary" onClick={handleSaveEdit} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Button variant="ghost" onClick={resetEdit}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm font-semibold text-ink">{report.subject}</p>
            <p className="text-sm text-ink-muted leading-relaxed">{bodyPreview}</p>
            {metricsText && (
              <p className="text-xs text-ink-dim">{metricsText}</p>
            )}
            <p className="text-xs text-ink-dim">
              {report.source_message_ids.length} source call
              {report.source_message_ids.length !== 1 ? 's' : ''}
            </p>
          </>
        )}
      </div>

      {/* ── Advisory + actions (hidden while editing; the editor lives in the diagnosis half) ── */}
      {!editing && (
      <div className="px-5 py-4 space-y-3 bg-surface-raised/50">
        <span className="text-xs font-medium uppercase tracking-wide text-ink-dim">Advisory</span>

        {/* Root cause hypothesis */}
        {advisory.root_cause_hypothesis && (
          <div className="flex items-start gap-2">
            <span className="text-xs font-medium px-2 py-0.5 rounded-full border border-line-strong text-ink-muted shrink-0">
              hypothesis
            </span>
            <p className="text-sm text-ink-muted">{advisory.root_cause_hypothesis}</p>
          </div>
        )}

        {/* Recommended actions */}
        {advisory.recommended_actions.length > 0 && (
          <ul className="space-y-2">
            {advisory.recommended_actions.map((a, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <span className={urgencyChip(a.urgency)}>{a.urgency}</span>
                <div className="flex-1 min-w-0">
                  <span className="text-ink">{a.action}</span>
                  <span className="ml-1 text-ink-dim text-xs">— {a.owner}</span>
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* Draft comms (collapsible) */}
        <div className="space-y-1.5">
          {advisory.draft_comms.customer_message && (
            <Collapsible label="Customer message">
              <p className="whitespace-pre-wrap">{advisory.draft_comms.customer_message}</p>
            </Collapsible>
          )}
          {advisory.draft_comms.internal_note && (
            <Collapsible label="Internal note">
              <p className="whitespace-pre-wrap">{advisory.draft_comms.internal_note}</p>
            </Collapsible>
          )}
          {advisory.draft_comms.talking_points.length > 0 && (
            <Collapsible label="Talking points">
              <ul className="list-disc list-inside space-y-1">
                {advisory.draft_comms.talking_points.map((pt, i) => (
                  <li key={i}>{pt}</li>
                ))}
              </ul>
            </Collapsible>
          )}
        </div>

        {/* Action buttons */}
        <div className="pt-1">
          {rejectingId === report.id ? (
            <div className="space-y-2">
              <textarea
                rows={2}
                value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
                placeholder="Reason for rejecting (optional)"
                className="w-full rounded-lg border border-line-strong bg-surface-raised text-ink placeholder:text-ink-dim px-3 py-2 text-sm transition focus:outline-none focus:border-accent focus:ring-2 focus:ring-magenta/40 resize-none"
              />
              <div className="flex gap-2">
                <Button variant="danger" onClick={handleReject}>
                  <XCircle size={15} />
                  Confirm reject
                </Button>
                <Button variant="ghost" onClick={() => { setRejectingId(null); setRejectReason(''); }}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2 flex-wrap">
              <Button variant="primary" onClick={handleApprove}>
                <CheckCircle2 size={15} />
                Approve
              </Button>
              <Button variant="danger" onClick={() => setRejectingId(report.id)}>
                <XCircle size={15} />
                Reject
              </Button>
              {!editing && (
                <Button variant="ghost" onClick={() => setEditing(true)}>
                  <Pencil size={15} />
                  Edit
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
      )}
    </Card>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function LineReportingPanel() {
  const { user, loading } = useAuth();
  const toast = useToast();
  const isAdmin = !loading && user?.role !== 'tenant_user';

  const [reports, setReports] = useState<LineReport[] | null>(null);
  const [sentOpen, setSentOpen] = useState(false);

  const load = useCallback(() => {
    const controller = new AbortController();
    getLineReports()
      .then(r => setReports(r.reports))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        toast.error('Could not load line reports.');
        setReports([]);
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

  const pending = reports?.filter(r => r.status === 'pending_approval') ?? [];
  const sent = reports?.filter(r => r.status === 'sent') ?? [];

  function handleReload() {
    setReports(null);
    load();
  }

  return (
    <section>
      <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wide mb-3">
        Line Reports — Pending for ABSA
      </h2>

      {reports === null ? (
        <div className="space-y-3">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : pending.length === 0 ? (
        <p className="text-sm text-ink-dim">
          No reports yet — Abe will draft updates as calls come in.
        </p>
      ) : (
        <div className="space-y-4">
          {pending.map(r => (
            <ReportCard key={r.id} report={r} onReload={handleReload} />
          ))}
        </div>
      )}

      {/* ── Sent section (collapsed by default) ── */}
      {reports !== null && sent.length > 0 && (
        <div className="mt-6">
          <button
            type="button"
            onClick={() => setSentOpen(o => !o)}
            className="flex items-center gap-2 text-sm font-medium text-ink-muted uppercase tracking-wide mb-3 hover:text-ink transition-colors"
          >
            {sentOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Sent ({sent.length})
          </button>
          {sentOpen && (
            <div className="space-y-2">
              {sent.map(r => (
                <Card key={r.id} className="flex items-start justify-between gap-3 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-ink truncate">{r.subject}</p>
                    <p className="text-xs text-ink-dim mt-0.5">
                      {r.report_type} · sent {r.sent_at ? new Date(r.sent_at).toLocaleDateString() : '—'}
                    </p>
                  </div>
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full border border-success/40 text-success shrink-0">
                    sent
                  </span>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
