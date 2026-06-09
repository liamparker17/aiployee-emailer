import { useState, useEffect, useCallback } from 'react';
import { Settings2 } from 'lucide-react';
import { Card } from '../Card';
import { Button } from '../Button';
import { Skeleton } from '../Skeleton';
import { useToast } from '../Toast';
import { useAuth } from '../../auth';
import { getLineSettings, putLineSettings } from '../../lib/abe';
import type { LineReportConfig } from '../../lib/abe';

// ── Default taxonomy ──────────────────────────────────────────────────────────

const DEFAULT_TAXONOMY = [
  'Billing',
  'Technical Issue',
  'Account Management',
  'Product Enquiry',
  'Complaint',
  'Cancellation',
  'New Business',
  'General Enquiry',
];

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ── Form state (mirrors putLineSettings camelCase keys) ───────────────────────

interface FormState {
  enabled: boolean;
  dailyDigest: boolean;
  weeklyRollup: boolean;
  weeklySendDay: number;
  sendHourUtc: number;
  recipientsRaw: string; // comma-separated textarea
  taxonomyRaw: string;   // newline-separated textarea
  spikePct: number;
  spikeMinCount: number;
  baselinePeriods: number;
  brandVoice: string;
  clientName: string;
  clientContext: string;
}

function configToForm(c: LineReportConfig): FormState {
  return {
    enabled: c.enabled,
    dailyDigest: c.daily_digest,
    weeklyRollup: c.weekly_rollup,
    weeklySendDay: c.weekly_send_day,
    sendHourUtc: c.send_hour_utc,
    recipientsRaw: c.recipients.join(', '),
    taxonomyRaw: c.taxonomy.join('\n'),
    spikePct: c.spike_pct,
    spikeMinCount: c.spike_min_count,
    baselinePeriods: c.baseline_periods,
    brandVoice: c.brand_voice ?? '',
    clientName: c.client_name ?? '',
    clientContext: c.client_context ?? '',
  };
}

function defaultForm(): FormState {
  return {
    enabled: false,
    dailyDigest: true,
    weeklyRollup: true,
    weeklySendDay: 1,
    sendHourUtc: 6,
    recipientsRaw: '',
    taxonomyRaw: DEFAULT_TAXONOMY.join('\n'),
    spikePct: 50,
    spikeMinCount: 5,
    baselinePeriods: 4,
    brandVoice: '',
    clientName: '',
    clientContext: '',
  };
}

// ── Row helpers ───────────────────────────────────────────────────────────────

const labelCls = 'block text-sm font-medium text-ink mb-1';
const inputCls =
  'w-full rounded-lg border border-line-strong bg-surface-raised text-ink placeholder:text-ink-dim px-3 py-2 text-sm transition focus:outline-none focus:border-accent focus:ring-2 focus:ring-magenta/40';

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className={labelCls}>{label}</label>
      {children}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function LineReportingSettings() {
  const { user, loading } = useAuth();
  const toast = useToast();
  const isAdmin = !loading && user?.role !== 'tenant_user';

  const [form, setForm] = useState<FormState | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    setLoadErr(null);
    getLineSettings()
      .then(({ config }) => {
        setForm(config ? configToForm(config) : defaultForm());
      })
      .catch((err: unknown) => {
        setLoadErr(err instanceof Error ? err.message : 'Could not load settings.');
      });
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    load();
  }, [isAdmin, load]);

  if (!isAdmin) return null;

  // ── handlers ────────────────────────────────────────────────────────────────

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(prev => prev ? { ...prev, [key]: value } : prev);
  }

  async function handleSave() {
    if (!form) return;
    setSaving(true);
    try {
      const recipients = form.recipientsRaw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      const taxonomy = form.taxonomyRaw
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);

      await putLineSettings({
        enabled: form.enabled,
        dailyDigest: form.dailyDigest,
        weeklyRollup: form.weeklyRollup,
        weeklySendDay: form.weeklySendDay,
        sendHourUtc: form.sendHourUtc,
        recipients,
        taxonomy,
        spikePct: form.spikePct,
        spikeMinCount: form.spikeMinCount,
        baselinePeriods: form.baselinePeriods,
        brandVoice: form.brandVoice,
        clientName: form.clientName.trim() || null,
        clientContext: form.clientContext.trim() || null,
      });
      setSavedAt(new Date());
      toast.success('Line reporting settings saved.');
      // Reload to get server-normalised values
      load();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Could not save settings.');
    } finally {
      setSaving(false);
    }
  }

  // ── render ───────────────────────────────────────────────────────────────────

  return (
    <section>
      {/* ── Section header with toggle ── */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 text-sm font-medium text-ink-muted uppercase tracking-wide mb-3 hover:text-ink transition-colors"
      >
        <Settings2 size={14} />
        Line Reporting Settings
        <span className="text-ink-dim">{open ? '▲' : '▼'}</span>
      </button>

      {!open && null}

      {open && (
        <Card className="space-y-5">
          {/* Loading skeleton */}
          {form === null && loadErr === null && (
            <div className="space-y-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-3/4" />
              <Skeleton className="h-8 w-1/2" />
            </div>
          )}

          {/* Error state */}
          {loadErr && (
            <div className="space-y-2">
              <p className="text-sm text-error">{loadErr}</p>
              <Button variant="secondary" onClick={load}>Retry</Button>
            </div>
          )}

          {/* Form */}
          {form && (
            <div className="space-y-5">
              {/* ── Client profile ── */}
              <div className="space-y-2">
                <FieldRow label="Client name">
                  <input
                    type="text"
                    value={form.clientName}
                    onChange={e => set('clientName', e.target.value)}
                    placeholder="e.g. ABSA"
                    className={inputCls}
                  />
                </FieldRow>

                <FieldRow label="Client / line context">
                  <textarea
                    rows={3}
                    value={form.clientContext}
                    onChange={e => set('clientContext', e.target.value)}
                    placeholder="A short note on who you report to and what this line is."
                    className={`${inputCls} resize-none`}
                  />
                  <p className="text-xs text-ink-dim">
                    A short note on who you report to and what this line is — Abe uses it to tailor his analysis and drafts.
                  </p>
                </FieldRow>
              </div>

              {/* ── Enable toggle ── */}
              <label className="flex items-center gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={e => set('enabled', e.target.checked)}
                  className="h-4 w-4 rounded border-line-strong accent-magenta"
                />
                <span className="text-sm font-medium text-ink">Enable line reporting</span>
              </label>

              {/* ── Cadence ── */}
              <div className="space-y-3">
                <p className={`${labelCls} !mb-0`}>Cadence</p>

                <label className="flex items-center gap-3 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={form.dailyDigest}
                    onChange={e => set('dailyDigest', e.target.checked)}
                    className="h-4 w-4 rounded border-line-strong accent-magenta"
                  />
                  <span className="text-sm text-ink-muted">Daily digest</span>
                </label>

                <label className="flex items-center gap-3 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={form.weeklyRollup}
                    onChange={e => set('weeklyRollup', e.target.checked)}
                    className="h-4 w-4 rounded border-line-strong accent-magenta"
                  />
                  <span className="text-sm text-ink-muted">Weekly rollup</span>
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <FieldRow label="Weekly send day">
                    <select
                      value={form.weeklySendDay}
                      onChange={e => set('weeklySendDay', Number(e.target.value))}
                      className={inputCls}
                    >
                      {DAYS.map((d, i) => (
                        <option key={i} value={i}>{d}</option>
                      ))}
                    </select>
                  </FieldRow>

                  <FieldRow label="Send hour (UTC 0–23)">
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={form.sendHourUtc}
                      onChange={e => set('sendHourUtc', Math.min(23, Math.max(0, Number(e.target.value))))}
                      className={inputCls}
                    />
                  </FieldRow>
                </div>
              </div>

              {/* ── Recipients ── */}
              <FieldRow label="Recipients (comma-separated emails)">
                <textarea
                  rows={3}
                  value={form.recipientsRaw}
                  onChange={e => set('recipientsRaw', e.target.value)}
                  placeholder="alice@absa.co.za, bob@absa.co.za"
                  className={`${inputCls} resize-none`}
                />
              </FieldRow>

              {/* ── Taxonomy ── */}
              <FieldRow label="Taxonomy categories (one per line)">
                <textarea
                  rows={8}
                  value={form.taxonomyRaw}
                  onChange={e => set('taxonomyRaw', e.target.value)}
                  className={`${inputCls} resize-y`}
                />
              </FieldRow>

              {/* ── Spike thresholds ── */}
              <div className="space-y-3">
                <p className={`${labelCls} !mb-0`}>Spike detection thresholds</p>
                <div className="grid grid-cols-3 gap-3">
                  <FieldRow label="Spike % above baseline">
                    <input
                      type="number"
                      min={0}
                      value={form.spikePct}
                      onChange={e => set('spikePct', Math.max(0, Number(e.target.value)))}
                      className={inputCls}
                    />
                  </FieldRow>

                  <FieldRow label="Min spike count">
                    <input
                      type="number"
                      min={1}
                      value={form.spikeMinCount}
                      onChange={e => set('spikeMinCount', Math.max(1, Number(e.target.value)))}
                      className={inputCls}
                    />
                  </FieldRow>

                  <FieldRow label="Baseline periods">
                    <input
                      type="number"
                      min={1}
                      value={form.baselinePeriods}
                      onChange={e => set('baselinePeriods', Math.max(1, Number(e.target.value)))}
                      className={inputCls}
                    />
                  </FieldRow>
                </div>
              </div>

              {/* ── Brand voice ── */}
              <FieldRow label="Brand voice instructions (optional)">
                <textarea
                  rows={4}
                  value={form.brandVoice}
                  onChange={e => set('brandVoice', e.target.value)}
                  placeholder="Describe the tone Abe should use when writing reports…"
                  className={`${inputCls} resize-none`}
                />
              </FieldRow>

              {/* ── Save bar ── */}
              <div className="flex items-center gap-4 pt-1">
                <Button
                  variant="primary"
                  onClick={handleSave}
                  disabled={saving}
                >
                  {saving ? 'Saving…' : 'Save settings'}
                </Button>

                {savedAt && !saving && (
                  <span className="text-xs text-success">
                    Saved {savedAt.toLocaleTimeString()}
                  </span>
                )}
              </div>
            </div>
          )}
        </Card>
      )}
    </section>
  );
}
