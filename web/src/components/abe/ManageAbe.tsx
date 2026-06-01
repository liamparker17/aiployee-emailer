import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { Field, Input } from '../Input';
import { useToast } from '../Toast';
import { useAuth } from '../../auth';
import { api } from '../../api';
import type { AbeGoal } from '../../lib/abe';

interface Props {
  open: boolean;
  onClose: () => void;
  goal: AbeGoal;
  onSaved: () => void;
}

export default function ManageAbe({ open, onClose, goal, onSaved }: Props) {
  const toast = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role !== 'tenant_user';

  const [enabled, setEnabled] = useState(goal.enabled);
  const [dormantWindowDays, setDormantWindowDays] = useState(String(goal.dormant_window_days));
  const [autoFireMaxAudience, setAutoFireMaxAudience] = useState(String(goal.auto_fire_max_audience));
  const [maxTouches, setMaxTouches] = useState(String(goal.max_touches));
  const [touchSpacingDays, setTouchSpacingDays] = useState(String(goal.touch_spacing_days));
  const [lineManagerEmail, setLineManagerEmail] = useState(goal.line_manager_email ?? '');
  const [brandVoice, setBrandVoice] = useState(goal.brand_voice ?? '');
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await api('/api/agent/goals', {
        method: 'PUT',
        body: JSON.stringify({
          enabled,
          dormantWindowDays: Number(dormantWindowDays),
          autoFireMaxAudience: Number(autoFireMaxAudience),
          maxTouches: Number(maxTouches),
          touchSpacingDays: Number(touchSpacingDays),
          lineManagerEmail: lineManagerEmail || null,
          brandVoice: brandVoice || null,
        }),
      });
      toast.success('Saved.');
      onSaved();
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  }

  async function handleVerifyManager() {
    setVerifying(true);
    try {
      await api('/api/agent/goals/verify-manager', { method: 'POST' });
      toast.success('Verification email sent to ' + goal.line_manager_email);
    } catch (err) {
      toast.error((err as Error).message ?? 'Could not send verification email.');
    } finally {
      setVerifying(false);
    }
  }

  const managerVerified = !!goal.line_manager_verified_at;
  const managerUnverified = !!goal.line_manager_email && !managerVerified;

  return (
    <Modal open={open} onClose={onClose} title="Manage Abe">
      <div className="space-y-5">

        {/* ── Pause / resume ── */}
        <section>
          <h4 className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-3">Pause Abe</h4>
          <label className="flex items-center gap-3 cursor-pointer">
            <div className="relative">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={enabled}
                disabled={!isAdmin}
                onChange={e => setEnabled(e.target.checked)}
              />
              <div className="w-10 h-6 rounded-full bg-line-strong peer-checked:bg-magenta transition-colors" />
              <div className="absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
            </div>
            <span className="text-sm text-ink">
              {enabled ? 'Abe is on shift' : 'Abe is paused'}
            </span>
          </label>
        </section>

        {/* ── Working limits ── */}
        <section>
          <h4 className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-3">Abe's working limits</h4>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Dormant window (days)" hint="Contacts idle at least this long">
              <Input
                type="number"
                min={1}
                value={dormantWindowDays}
                disabled={!isAdmin}
                onChange={e => setDormantWindowDays(e.target.value)}
              />
            </Field>
            <Field label="Max audience per play" hint="Cap on contacts per re-engage run">
              <Input
                type="number"
                min={0}
                value={autoFireMaxAudience}
                disabled={!isAdmin}
                onChange={e => setAutoFireMaxAudience(e.target.value)}
              />
            </Field>
            <Field label="Max touches per contact">
              <Input
                type="number"
                min={1}
                value={maxTouches}
                disabled={!isAdmin}
                onChange={e => setMaxTouches(e.target.value)}
              />
            </Field>
            <Field label="Days between touches">
              <Input
                type="number"
                min={1}
                value={touchSpacingDays}
                disabled={!isAdmin}
                onChange={e => setTouchSpacingDays(e.target.value)}
              />
            </Field>
          </div>
        </section>

        {/* ── Brand voice ── */}
        <section>
          <Field label="Brand voice" hint="How Abe should write — tone, style, sign-off name">
            <textarea
              rows={3}
              value={brandVoice}
              disabled={!isAdmin}
              onChange={e => setBrandVoice(e.target.value)}
              placeholder="e.g. Friendly but professional. Sign off as 'The Regalis team'."
              className="w-full rounded-lg border border-line-strong bg-surface-raised text-ink placeholder:text-ink-dim px-3 py-2 text-sm transition focus:outline-none focus:border-accent focus:ring-2 focus:ring-magenta/40 resize-none disabled:opacity-60"
            />
          </Field>
        </section>

        {/* ── Line manager ── */}
        <section>
          <h4 className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-3">Who Abe reports to</h4>
          <p className="text-xs text-ink-dim mb-3">
            Abe can only email his manager for sign-off once the address is verified.
          </p>
          <Field label="Line manager email">
            <Input
              type="email"
              value={lineManagerEmail}
              disabled={!isAdmin}
              onChange={e => setLineManagerEmail(e.target.value)}
              placeholder="manager@company.com"
            />
          </Field>

          {/* Verification status */}
          {managerVerified && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-success">
              <CheckCircle2 size={13} />
              <span>Address verified</span>
            </div>
          )}
          {managerUnverified && isAdmin && (
            <div className="mt-3">
              <Button
                variant="secondary"
                onClick={handleVerifyManager}
                disabled={verifying}
              >
                {verifying ? 'Sending…' : 'Send verification email'}
              </Button>
            </div>
          )}
          {managerUnverified && !isAdmin && (
            <p className="mt-2 text-xs text-ink-dim">Pending verification by an admin.</p>
          )}
        </section>

        {/* ── Read-only note for non-admins ── */}
        {!isAdmin && (
          <p className="text-xs text-ink-dim border border-line rounded-lg px-3 py-2">
            You're viewing Abe's settings in read-only mode. Contact an admin to make changes.
          </p>
        )}

        {/* ── Actions ── */}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {isAdmin && (
            <Button variant="primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
