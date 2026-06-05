import { api } from '../api';

// ── Legacy slim type (used by existing Calls.tsx components) ──────────────────
export interface Call {
  id: string;
  created_at: string;
  content: string;
  category: string | null;
  severity: string | null;
}

// ── Full structured row (Call Analytics Center) ───────────────────────────────
export interface CallRow {
  id: string;
  created_at: string;
  content: string;
  category: string | null;
  severity: string | null;
  caller_name: string | null;
  caller_phone: string | null;
  attribution_label: string | null;
  call_type: string | null;
  call_outcome: string | null;
  sentiment: string | null;
  call_duration_seconds: number | null;
  callback_requested: boolean | null;
  escalation_requested: boolean | null;
  resolution_state: string | null;
}

// ── Filters for listCalls / exportCallsCsvUrl ─────────────────────────────────
export interface CallFilters {
  category?: string;
  search?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  attribution?: string;
  outcome?: string;
  sentiment?: string;
  resolution?: string;
  callbackRequested?: boolean;
  escalationRequested?: boolean;
  sort?:
    | 'created_at'
    | 'attribution_label'
    | 'category'
    | 'call_outcome'
    | 'sentiment'
    | 'call_duration_seconds'
    | 'resolution_state';
  sortDir?: 'asc' | 'desc';
}

// ── Breakdown response (Call Analytics Center) ────────────────────────────────
// NOTE: byCategory uses {category,count} (legacy shape); all other by* arrays use {key,count}.
export interface CallBreakdown {
  window: string;
  total: number;
  summary: {
    total: number;
    resolved: number;
    resolutionRatePct: number;
    fcrCount: number;
    callbackCount: number;
    escalationCount: number;
    avgDurationSeconds: number;
    sentimentMix: {
      positive: number;
      neutral: number;
      negative: number;
      unknown: number;
    };
  };
  byCategory: Array<{ category: string; count: number }>;
  byDepartment: Array<{ key: string | null; count: number }>;
  byOutcome: Array<{ key: string | null; count: number }>;
  bySentiment: Array<{ key: string | null; count: number }>;
  byResolution: Array<{ key: string | null; count: number }>;
  crosstab: Array<{
    attribution_label: string | null;
    category: string | null;
    count: number;
  }>;
  perDay: Array<{ day: string; count: number }>;
}

// ── Legacy Breakdown type (used by existing Calls.tsx) ────────────────────────
export interface Breakdown {
  window: string;
  total: number;
  byCategory: Array<{ category: string; count: number }>;
  perDay: Array<{ day: string; count: number }>;
}

// ── Query-string builder (shared by list + export) ────────────────────────────
function buildCallsQs(filters: CallFilters): string {
  const p = new URLSearchParams();
  const { callbackRequested, escalationRequested, ...rest } = filters;
  Object.entries(rest).forEach(([k, v]) => {
    if (v !== undefined && v !== '') p.set(k, String(v));
  });
  if (callbackRequested !== undefined) p.set('callbackRequested', String(callbackRequested));
  if (escalationRequested !== undefined) p.set('escalationRequested', String(escalationRequested));
  return p.toString();
}

// ── Call Analytics Center fetch functions ─────────────────────────────────────

/** Fetch a paginated, filtered list of structured call rows. */
export const listCalls = (filters: CallFilters = {}): Promise<{ calls: CallRow[]; total: number }> => {
  const qs = buildCallsQs(filters);
  return api<{ calls: CallRow[]; total: number }>(`/api/calls${qs ? `?${qs}` : ''}`);
};

/** Fetch multi-dimension breakdown stats for a given time window. */
export const getCallBreakdown = (window: 'today' | '7d' | '30d'): Promise<CallBreakdown> =>
  api<CallBreakdown>(`/api/calls/breakdown?window=${window}`);

/** Fetch a single call row by ID. */
export const getCall = (id: string): Promise<CallRow> => api<CallRow>(`/api/calls/${id}`);

/**
 * Returns the URL for a CSV export of calls matching the given filters.
 * Pass this directly to an `<a href>` download link — no fetch required.
 */
export const exportCallsCsvUrl = (filters: CallFilters = {}): string => {
  const qs = buildCallsQs(filters);
  return `/api/calls/export.csv${qs ? `?${qs}` : ''}`;
};

// ── Legacy helpers (used by existing Calls.tsx — keep these intact) ───────────

export const getBreakdown = (window: string) =>
  api<Breakdown>(`/api/calls/breakdown?window=${window}`);

export const getCategories = () => api<{ categories: string[] }>(`/api/calls/categories`);

export const putCategories = (categories: string[]) =>
  api<{ categories: string[] }>(`/api/calls/categories`, {
    method: 'PUT',
    body: JSON.stringify({ categories }),
  });

export const suggestCategories = () =>
  api<{ suggested: string[] }>(`/api/calls/suggest-categories`, { method: 'POST' });

export const retagCalls = () =>
  api<{ retagged: number; remaining: number }>(`/api/calls/retag`, { method: 'POST' });

export const getCallSettings = () =>
  api<{ ingestSendsAsCalls: boolean }>(`/api/calls/settings`);

export const putCallSettings = (ingestSendsAsCalls: boolean) =>
  api<{ ingestSendsAsCalls: boolean }>(`/api/calls/settings`, {
    method: 'PUT',
    body: JSON.stringify({ ingestSendsAsCalls }),
  });

export const importPastCalls = () =>
  api<{ imported: number; tagged: number }>(`/api/calls/import-past`, { method: 'POST' });

export const autoSetupCategories = (opts?: { categories?: string[]; replace?: boolean }) =>
  api<{ categories: string[]; tagged: number; applied: boolean }>(`/api/calls/setup-categories`, {
    method: 'POST',
    body: JSON.stringify(opts ?? {}),
  });
