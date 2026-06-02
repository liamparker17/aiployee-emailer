import { api } from '../api';

export interface AbeGoal {
  id: string; enabled: boolean;
  dormant_window_days: number; auto_fire_max_audience: number;
  max_touches: number; touch_spacing_days: number;
  line_manager_email: string | null; line_manager_verified_at: string | null;
  brand_voice: string | null;
}
export interface AbeTouch { index: number; subject: string; body_html: string; scheduled_offset_days: number }
export type AbePlayStatus = 'proposed'|'pending_approval'|'approved'|'rejected'|'executing'|'done'|'archived';
export interface AbePlay {
  id: string; status: AbePlayStatus; risk_score: number;
  audience_snapshot: { contact_ids: string[]; size: number };
  touches: AbeTouch[]; rejection_reason: string | null;
  executed_at: string | null; created_at: string;
}
export interface AbeFeedEntry { playId: string; at: string; kind: string; text: string }

// ── Line-report types ────────────────────────────────────────────────────────

export interface Advisory {
  diagnosis: string;
  root_cause_hypothesis: string | null;
  recommended_actions: Array<{ action: string; owner: string; urgency: 'low' | 'med' | 'high' }>;
  draft_comms: { customer_message: string; internal_note: string; talking_points: string[] };
}

export interface LineReport {
  id: string;
  report_type: 'digest' | 'alert' | 'answer' | 'case';
  status: string;
  subject: string;
  body: string;
  metrics: unknown;
  advisory: Advisory;
  source_message_ids: string[];
  created_at: string;
  sent_at: string | null;
}

export interface LineReportConfig {
  enabled: boolean;
  daily_digest: boolean;
  weekly_rollup: boolean;
  weekly_send_day: number;
  send_hour_utc: number;
  recipients: string[];
  taxonomy: string[];
  spike_pct: number;
  spike_min_count: number;
  baseline_periods: number;
  brand_voice: string | null;
}

// ── Line-report API helpers ──────────────────────────────────────────────────

export const getLineReports = (status?: string) =>
  api<{ reports: LineReport[] }>(`/api/agent/line-reports${status ? `?status=${encodeURIComponent(status)}` : ''}`);

export const getLineReport = (id: string) =>
  api<{ report: LineReport }>(`/api/agent/line-reports/${id}`);

export const approveLineReport = (id: string) =>
  api(`/api/agent/line-reports/${id}/approve`, { method: 'POST' });

export const rejectLineReport = (id: string, reason: string) =>
  api(`/api/agent/line-reports/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });

export const patchLineReport = (
  id: string,
  b: { subject?: string; body?: string; advisory?: Advisory },
) => api(`/api/agent/line-reports/${id}`, { method: 'PATCH', body: JSON.stringify(b) });

export const getLineSettings = () =>
  api<{ config: LineReportConfig | null }>(`/api/agent/line-report-settings`);

export const putLineSettings = (
  b: Partial<{
    enabled: boolean;
    dailyDigest: boolean;
    weeklyRollup: boolean;
    weeklySendDay: number;
    sendHourUtc: number;
    recipients: string[];
    taxonomy: string[];
    spikePct: number;
    spikeMinCount: number;
    baselinePeriods: number;
    brandVoice: string;
  }>,
) => api<{ config: LineReportConfig }>(`/api/agent/line-report-settings`, { method: 'PUT', body: JSON.stringify(b) });
