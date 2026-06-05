// Pure helpers for normalizing a Jobix post-call payload. No DB, no IO.

// "3 minutes 42 seconds" -> 222. Accepts minutes-only / seconds-only. null if unparseable.
export function parseDurationSeconds(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const m = raw.match(/(\d+)\s*min/i);
  const s = raw.match(/(\d+)\s*sec/i);
  if (!m && !s) return null;
  return (m ? Number(m[1]) * 60 : 0) + (s ? Number(s[1]) : 0);
}

export interface AttributionMap { source?: 'agent' | 'values_key'; values_key?: string }

export interface NormalizedCall {
  callerSuid: string | null; callerName: string | null;
  callerPhone: string | null; callerTimezone: string | null;
  lineRef: string | null; attributionLabel: string | null; callType: string | null;
  summary: string | null; callOutcome: string | null; sentiment: string | null;
  callDurationSeconds: number | null;
  callbackRequested: boolean; callbackPreferredTime: string | null;
  escalationRequested: boolean;
  values: Record<string, unknown>;
}

const str = (v: unknown): string | null =>
  (typeof v === 'string' && v.trim()) ? v.trim() : (typeof v === 'number' ? String(v) : null);
const bool = (v: unknown): boolean => v === true || v === 'true' || v === 'yes';

const TYPE_KEYS = ['type', 'Call', 'call', 'context', 'call_purpose'];

// Pick the call-type / attribution label out of the values bag.
function pickType(values: Record<string, unknown>): string | null {
  for (const k of TYPE_KEYS) { const v = str(values[k]); if (v) return v; }
  return null;
}

export function normalizeCall(body: unknown, attribution: AttributionMap, lineRef?: string | null): NormalizedCall {
  const b = (body ?? {}) as Record<string, unknown>;
  const cd = (b.customer_data ?? {}) as Record<string, unknown>;
  const main = (cd.main ?? {}) as Record<string, unknown>;
  const values = ((cd.values ?? {}) as Record<string, unknown>) ?? {};

  // suid/summary may live in main, values, or at the top level (flat shape).
  const callerSuid = str(main.suid) ?? str(b.suid) ?? str(values.suid);
  const summary    = str(values.call_summary) ?? str(values.summary) ?? str(b.call_summary) ?? str(b.summary);
  const get = (k: string): unknown => values[k] ?? b[k];

  const callType = pickType(values);
  let attributionLabel: string | null;
  if (attribution.source === 'agent') attributionLabel = lineRef ?? null;
  else if (attribution.source === 'values_key' && attribution.values_key)
    attributionLabel = str(values[attribution.values_key]);
  else attributionLabel = callType; // default heuristic

  return {
    callerSuid,
    callerName: str(main.name) ?? str(b.name) ?? str(values.full_name) ?? str(values.first_name),
    callerPhone: str(main.phone) ?? str(b.phone) ?? str(values.phone_number) ?? str(values.cell_number),
    callerTimezone: str(main.timezone) ?? str(b.timezone),
    lineRef: lineRef ?? null,
    attributionLabel,
    callType,
    summary,
    callOutcome: str(get('call_outcome')),
    sentiment: str(get('sentiment')),
    callDurationSeconds: parseDurationSeconds(get('call_duration')),
    callbackRequested: bool(get('callback_requested')),
    callbackPreferredTime: str(get('callback_preferred_time')) ?? str(get('callback_time')),
    escalationRequested: bool(get('escalation_requested')),
    values,
  };
}
