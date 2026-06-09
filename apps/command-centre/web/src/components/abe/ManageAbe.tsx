import { useState, useEffect } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Modal } from '@aiployee/ui';
import { Button } from '@aiployee/ui';
import { Field, Input } from '@aiployee/ui';
import { useToast } from '@aiployee/ui';
import { useAuth } from '@aiployee/ui';
import { api } from '@aiployee/ui';
import type { AbeGoal } from '../../lib/abe';

function describeError(err: unknown): string {
  const e = err as { message?: string; details?: Array<{ path?: (string | number)[]; message?: string }> };
  if (Array.isArray(e?.details) && e.details.length) {
    return e.details.map(i => `${(i.path ?? []).join('.') || 'field'}: ${i.message ?? 'invalid'}`).join('; ');
  }
  return e?.message || 'Something went wrong.';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clamp(value: string, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : fallback));
}

interface Props {
  open: boolean;
  onClose: () => void;
  goal: AbeGoal;
  onSaved: () => void;
}

interface AgentCfg {
  has_key: boolean;
  enabled: boolean;
  model: string;
  system_prompt: string;
  auto_approve_jobix: boolean;
  max_tool_iterations: number;
}

export default function ManageAbe({ open, onClose, goal, onSaved }: Props) {
  const toast = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role !== 'tenant_user';

  const [agentCfg, setAgentCfg] = useState<AgentCfg | null>(null);
  const [openaiKey, setOpenaiKey] = useState('');

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    api<{ config: AgentCfg | null }>('/api/agent/config')
      .then(r => { if (!cancelled) setAgentCfg(r.config); })
      .catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  }, [isAdmin]);

  const [enabled, setEnabled] = useState(goal.enabled);
  const [dormantWindowDays, setDormantWindowDays] = useState(goal.dormant_window_days);
  const [autoFireMaxAudience, setAutoFireMaxAudience] = useState(goal.auto_fire_max_audience);
  const [maxTouches, setMaxTouches] = useState(goal.max_touches);
  const [touchSpacingDays, setTouchSpacingDays] = useState(goal.touch_spacing_days);
  const [lineManagerEmail, setLineManagerEmail] = useState(goal.line_manager_email ?? '');
  const [brandVoice, setBrandVoice] = useState(goal.brand_voice ?? '');
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);

  async function handleSave() {
    if (lineManagerEmail && !EMAIL_RE.test(lineManagerEmail)) {
      toast.error('Enter a valid manager email, e.g. name@company.com');
      return;
    }
    setSaving(true);
    try {
      await api('/api/agent/goals', {
        method: 'PUT',
        body: JSON.stringify({
          enabled,
          dormantWindowDays,
          autoFireMaxAudience,
          maxTouches,
          touchSpacingDays,
          lineManagerEmail: lineManagerEmail || null,
          brandVoice: brandVoice || null,
        }),
      });
      if (openaiKey.trim()) {
        try {
          await api('/api/agent/config', {
            method: 'PUT',
            body: JSON.stringify({
              enabled: agentCfg?.enabled ?? false,
              model: agentCfg?.model || 'gpt-4.1',
              systemPrompt: agentCfg?.system_prompt ?? '',
              autoApproveJobix: agentCfg?.auto_approve_jobix ?? true,
              maxToolIterations: agentCfg?.max_tool_iterations ?? 4,
              openaiKey: openaiKey.trim(),
            }),
          });
        } catch (err) {
          toast.error(describeError(err));
          setSaving(false);
          return;
        }
      }
      toast.success('Saved.');
      setOpenaiKey('');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleVerifyManager() {
    setVerifying(true);
    try {
      await api('/api/agent/goals/verify-manager', { method: 'POST' });
      toast.success('Verification email sent to ' + goal.line_manager_email + '.');
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
          <h4 className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-3">Abe's shift status</h4>
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
            <Field label="Dormant window (days)" hint="Contacts idle at least this long (1–3650)">
              <Input
                type="number"
                min={1}
                max={3650}
                step={1}
                value={dormantWindowDays}
                disabled={!isAdmin}
                onChange={e => setDormantWindowDays(clamp(e.target.value, 1, 3650, 1))}
              />
            </Field>
            <Field label="Max audience per play" hint="Cap on contacts per re-engage run (0–100000)">
              <Input
                type="number"
                min={0}
                max={100000}
                step={1}
                value={autoFireMaxAudience}
                disabled={!isAdmin}
                onChange={e => setAutoFireMaxAudience(clamp(e.target.value, 0, 100000, 0))}
              />
            </Field>
            <Field label="Max touches per contact" hint="1–5">
              <Input
                type="number"
                min={1}
                max={5}
                step={1}
                value={maxTouches}
                disabled={!isAdmin}
                onChange={e => setMaxTouches(clamp(e.target.value, 1, 5, 1))}
              />
            </Field>
            <Field label="Days between touches" hint="1–60">
              <Input
                type="number"
                min={1}
                max={60}
                step={1}
                value={touchSpacingDays}
                disabled={!isAdmin}
                onChange={e => setTouchSpacingDays(clamp(e.target.value, 1, 60, 1))}
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
            <div className="mt-3 space-y-1">
              <Button
                variant="secondary"
                onClick={handleVerifyManager}
                disabled={verifying || lineManagerEmail !== goal.line_manager_email}
              >
                {verifying ? 'Sending…' : 'Send verification email'}
              </Button>
              {lineManagerEmail !== goal.line_manager_email && (
                <p className="text-xs text-ink-dim">Save changes first to verify the new address.</p>
              )}
            </div>
          )}
          {managerUnverified && !isAdmin && (
            <p className="mt-2 text-xs text-ink-dim">Pending verification by an admin.</p>
          )}
        </section>

        {/* ── OpenAI API key (admin only) ── */}
        {isAdmin && (
          <section>
            <h4 className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-3">OpenAI connection</h4>
            <Field
              label="OpenAI API key"
              hint={agentCfg?.has_key
                ? 'Connected — leave blank to keep the current key.'
                : 'Not connected — Abe can\'t run without this.'}
            >
              <Input
                type="password"
                placeholder="sk-…"
                value={openaiKey}
                onChange={e => setOpenaiKey(e.target.value)}
              />
            </Field>
          </section>
        )}

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
