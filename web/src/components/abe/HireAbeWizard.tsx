import { useState } from 'react';
import { Button } from '../Button';
import { Card } from '../Card';
import { Input, Field } from '../Input';
import { useToast } from '../Toast';
import { api } from '../../api';
import { useAuth } from '../../auth';
import type { AbeGoal } from '../../lib/abe';

interface Props { goal: AbeGoal | null; onHired: () => void }

interface FormState {
  lineManagerEmail: string;
  dormantWindowDays: number;
  autoFireMaxAudience: number;
  maxTouches: number;
  touchSpacingDays: number;
  brandVoice: string;
}

function seedForm(goal: AbeGoal | null): FormState {
  return {
    lineManagerEmail: goal?.line_manager_email ?? '',
    dormantWindowDays: goal?.dormant_window_days ?? 60,
    autoFireMaxAudience: goal?.auto_fire_max_audience ?? 0,
    maxTouches: goal?.max_touches ?? 3,
    touchSpacingDays: goal?.touch_spacing_days ?? 3,
    brandVoice: goal?.brand_voice ?? '',
  };
}

const TOTAL_STEPS = 5;

export default function HireAbeWizard({ goal, onHired }: Props) {
  const { user } = useAuth();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>(() => seedForm(goal));
  const [saving, setSaving] = useState(false);

  const isAdmin = user?.role !== 'tenant_user';

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(f => ({ ...f, [key]: value }));
  }

  async function hire() {
    setSaving(true);
    try {
      await api('/api/agent/goals', {
        method: 'PUT',
        body: JSON.stringify({
          enabled: true,
          lineManagerEmail: form.lineManagerEmail || null,
          dormantWindowDays: form.dormantWindowDays,
          autoFireMaxAudience: form.autoFireMaxAudience,
          maxTouches: form.maxTouches,
          touchSpacingDays: form.touchSpacingDays,
          brandVoice: form.brandVoice || null,
        }),
      });
      toast.success('Abe is hired — he starts his first shift on the next cycle.');
      onHired();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong — Abe could not be hired.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-xl mx-auto py-10 px-4">
      {/* Step indicator */}
      <p className="text-xs font-medium text-ink-muted mb-4 tracking-wide uppercase">
        Step {step + 1} of {TOTAL_STEPS}
      </p>

      {/* Progress bar */}
      <div className="w-full bg-surface-raised rounded-full h-1 mb-6">
        <div
          className="bg-brand h-1 rounded-full transition-all"
          style={{ width: `${((step + 1) / TOTAL_STEPS) * 100}%` }}
        />
      </div>

      <Card className="space-y-6">
        {/* ── Step 0: Meet Abe ── */}
        {step === 0 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-ink">Meet Abe, your re-engagement specialist</h2>
            <p className="text-sm text-ink-muted leading-relaxed">
              Hi — I'm Abe. My job is to win back contacts who've gone quiet. I watch your contact list,
              spot anyone who hasn't heard from you in a while, and draft a sequence of personalised
              follow-ups for your review before I send a single word.
            </p>
            <p className="text-sm text-ink-muted leading-relaxed">
              Before I start my first shift, I need a quick briefing — five short steps and we're done.
              You can adjust everything later from my settings panel.
            </p>
            <div className="flex justify-end pt-2">
              <Button variant="primary" onClick={() => setStep(1)}>
                Let's get started →
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 1: Manager ── */}
        {step === 1 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-ink">Who does Abe report to?</h2>
            <p className="text-sm text-ink-muted">
              When a play needs sign-off, I'll email this address for approval — so make sure it's
              someone who can act quickly. You can verify the address after hiring me.
            </p>
            <Field label="Manager email address" hint="Optional — leave blank to skip email sign-off for now.">
              <Input
                type="email"
                placeholder="manager@yourcompany.com"
                value={form.lineManagerEmail}
                onChange={e => set('lineManagerEmail', e.target.value)}
              />
            </Field>
            <div className="flex justify-between pt-2">
              <Button variant="ghost" onClick={() => setStep(0)}>← Back</Button>
              <Button variant="primary" onClick={() => setStep(2)}>Next →</Button>
            </div>
          </div>
        )}

        {/* ── Step 2: Goal ── */}
        {step === 2 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-ink">Brief the goal</h2>
            <p className="text-sm text-ink-muted">
              Tell me how long a contact needs to be quiet before I flag them for a win-back play.
              Shorter windows mean I work harder; longer windows give contacts more breathing room.
            </p>
            <Field label="Win back contacts quiet for…" hint="Days without any outbound touch. Default: 60 days.">
              <Input
                type="number"
                min={1}
                value={form.dormantWindowDays}
                onChange={e => set('dormantWindowDays', Math.max(1, Number(e.target.value)))}
              />
            </Field>
            <div className="flex justify-between pt-2">
              <Button variant="ghost" onClick={() => setStep(1)}>← Back</Button>
              <Button variant="primary" onClick={() => setStep(3)}>Next →</Button>
            </div>
          </div>
        )}

        {/* ── Step 3: Working limits ── */}
        {step === 3 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-ink">My employment agreement</h2>
            <p className="text-sm text-ink-muted">
              Set the guardrails for how I work — how many contacts I can reach at once, how many
              touches per sequence, and the gap between them.
            </p>
            <Field
              label="Max audience per play"
              hint="0 = Abe always asks before sending. Higher values let Abe auto-fire to that many contacts."
            >
              <Input
                type="number"
                min={0}
                value={form.autoFireMaxAudience}
                onChange={e => set('autoFireMaxAudience', Math.max(0, Number(e.target.value)))}
              />
            </Field>
            <Field label="Max touches per sequence" hint="How many emails in each win-back sequence. Default: 3.">
              <Input
                type="number"
                min={1}
                value={form.maxTouches}
                onChange={e => set('maxTouches', Math.max(1, Number(e.target.value)))}
              />
            </Field>
            <Field label="Days between touches" hint="Minimum gap between emails in a sequence. Default: 3 days.">
              <Input
                type="number"
                min={1}
                value={form.touchSpacingDays}
                onChange={e => set('touchSpacingDays', Math.max(1, Number(e.target.value)))}
              />
            </Field>
            <Field label="Brand voice (optional)" hint="A short note on tone — e.g. 'friendly but professional, no jargon'.">
              <textarea
                rows={3}
                placeholder="Friendly, conversational, avoid buzzwords…"
                value={form.brandVoice}
                onChange={e => set('brandVoice', e.target.value)}
                className="w-full rounded-lg border border-line-strong bg-surface-raised text-ink placeholder:text-ink-dim px-3 py-2 text-sm transition focus:outline-none focus:border-accent focus:ring-2 focus:ring-magenta/40 resize-none"
              />
            </Field>
            <div className="flex justify-between pt-2">
              <Button variant="ghost" onClick={() => setStep(2)}>← Back</Button>
              <Button variant="primary" onClick={() => setStep(4)}>Next →</Button>
            </div>
          </div>
        )}

        {/* ── Step 4: Start first shift ── */}
        {step === 4 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-ink">Ready to start his first shift</h2>
            <p className="text-sm text-ink-muted">Here's a summary of Abe's briefing — confirm and hire him.</p>

            <div className="rounded-xl border border-line bg-surface-raised p-4 space-y-2 text-sm">
              <Row label="Reports to" value={form.lineManagerEmail || '—'} />
              <Row label="Dormant window" value={`${form.dormantWindowDays} days`} />
              <Row label="Auto-fire audience" value={form.autoFireMaxAudience === 0 ? 'Always ask first (0)' : String(form.autoFireMaxAudience)} />
              <Row label="Touches per sequence" value={String(form.maxTouches)} />
              <Row label="Days between touches" value={String(form.touchSpacingDays)} />
              {form.brandVoice && <Row label="Brand voice" value={form.brandVoice} />}
            </div>

            {!isAdmin && (
              <p className="text-sm text-ink-muted border border-line rounded-lg px-4 py-3 bg-surface-raised">
                Only an admin can hire Abe. Ask an admin to complete this step.
              </p>
            )}

            <div className="flex justify-between pt-2">
              <Button variant="ghost" onClick={() => setStep(3)}>← Back</Button>
              <Button
                variant="primary"
                disabled={!isAdmin || saving}
                onClick={hire}
              >
                {saving ? 'Hiring…' : 'Hire Abe & start his first shift'}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-ink-muted w-40 shrink-0">{label}</span>
      <span className="text-ink break-words">{value}</span>
    </div>
  );
}
