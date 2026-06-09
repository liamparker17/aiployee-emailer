import { api } from '@aiployee/ui';

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
  client_name: string | null;
  client_context: string | null;
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
    clientName: string | null;
    clientContext: string | null;
  }>,
) => api<{ config: LineReportConfig }>(`/api/agent/line-report-settings`, { method: 'PUT', body: JSON.stringify(b) });

// ── Callback-handover types & API helpers ────────────────────────────────────

export interface Handover {
  id: string; status: 'pending'|'forwarded'|'dismissed';
  caller_name: string | null; caller_phone: string | null; account_ref: string | null;
  reason_category: string; summary: string; recommended_action: string;
  urgency: 'low'|'med'|'high'; vulnerable: boolean; missing_fields: string[]; repeat_of: string | null;
  forwarded_at: string | null; created_at: string;
}
export const getHandovers = (status?: string) => api<{ handovers: Handover[] }>(`/api/agent/handovers${status ? `?status=${status}` : ''}`);
export const forwardHandover = (id: string) => api<{ handover: Handover }>(`/api/agent/handovers/${id}/forward`, { method: 'POST' });
export const dismissHandover = (id: string, reason: string) => api(`/api/agent/handovers/${id}/dismiss`, { method: 'POST', body: JSON.stringify({ reason }) });
export const patchHandover = (id: string, b: Partial<Pick<Handover,'caller_name'|'caller_phone'|'account_ref'|'recommended_action'|'urgency'>>) => api<{ handover: Handover }>(`/api/agent/handovers/${id}`, { method: 'PATCH', body: JSON.stringify(b) });
