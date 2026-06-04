import { useState, useCallback, useEffect } from 'react';
import { Bot, ShieldCheck } from 'lucide-react';
import { Card } from '../Card';
import AbeFeed from './AbeFeed';
import AbeReadiness from './AbeReadiness';
import AbeChat from './AbeChat';
import LineReportingPanel from './LineReportingPanel';
import LineReportingSettings from './LineReportingSettings';
import CallbackHandoverPanel from './CallbackHandoverPanel';
import { getLineSettings, type LineReportConfig } from '../../lib/abe';

function statusLine(config: LineReportConfig | null, ready: boolean | null): string {
  if (!config || !config.enabled) return 'Paused — not watching the line yet';
  const clientName = config.client_name?.trim() || 'your client';
  if (ready === false) return `Needs setup before he can send to ${clientName}`;
  return 'On the line · drafting client updates for your sign-off';
}

export default function AbeHome() {
  const [feedKey, setFeedKey] = useState(0);
  const [readinessKey, setReadinessKey] = useState(0);
  // null = loading, true/false = resolved from AbeReadiness
  const [ready, setReady] = useState<boolean | null>(null);
  const [config, setConfig] = useState<LineReportConfig | null>(null);
  const handleReady = useCallback((r: boolean) => setReady(r), []);
  const clientName = config?.client_name?.trim() || 'your client';

  const loadConfig = useCallback(() => {
    getLineSettings().then((r) => setConfig(r.config)).catch(() => {});
  }, []);
  useEffect(() => { loadConfig(); }, [loadConfig]);

  const refresh = () => {
    setFeedKey((k) => k + 1);
    setReadinessKey((k) => k + 1);
    loadConfig();
  };

  return (
    <div className="space-y-6">
      {/* ── Readiness banner (renders nothing when prereqs are met) ── */}
      <AbeReadiness key={readinessKey} onReady={handleReady} />

      {/* ── Callback queue (centrepiece: client callbacks to forward) ── */}
      <CallbackHandoverPanel />

      {/* ── Who Abe is (identity + the no-cold-contact guarantee) ── */}
      <Card className="space-y-3">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-magenta/15 text-magenta">
            <Bot size={26} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-lg font-heading font-semibold text-ink">
              Abe — your call-line analyst &amp; client liaison
            </p>
            <p className="text-sm text-ink-muted mt-0.5">{statusLine(config, ready)}</p>
          </div>
        </div>
        <p className="text-sm text-ink-muted leading-relaxed">
          Abe reads what people phone the line about, flags what matters — spikes, complaints,
          urgent cases — and drafts the updates to <span className="font-medium text-ink">{clientName}</span>,
          diagnosing each issue <em>and</em> recommending how to handle it. You approve; he sends.
        </p>
        <p className="flex items-start gap-2 text-sm text-ink-muted">
          <ShieldCheck size={16} className="mt-0.5 shrink-0 text-magenta" />
          <span>
            <span className="font-medium text-ink">Abe never cold-contacts anyone.</span>{' '}
            He only ever writes to {clientName} — never to leads or customers — and nothing
            leaves without your sign-off.
          </span>
        </p>
      </Card>

      {/* ── The job: line reporting (what's coming in + the Pending-for-client queue) ── */}
      <LineReportingPanel />

      {/* ── Talk to Abe ── */}
      <AbeChat onActed={refresh} clientName={clientName} />

      {/* ── How Abe works (cadence, recipients, categories, voice) ── */}
      <LineReportingSettings />

      {/* ── Work log ── */}
      <section>
        <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wide mb-3">
          Abe's work log
        </h2>
        <AbeFeed key={feedKey} />
      </section>
    </div>
  );
}
