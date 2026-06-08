import type pg from 'pg';
import type { NormalizedCall } from '../agent/abe/jobixPayload.js';

export interface CallFactsRow {
  id: string; tenant_id: string; message_id: string;
  caller_suid: string | null; caller_name: string | null;
  caller_phone: string | null; caller_timezone: string | null;
  line_ref: string | null; attribution_label: string | null; call_type: string | null;
  summary: string | null; call_outcome: string | null; sentiment: string | null;
  call_duration_seconds: number | null;
  callback_requested: boolean; callback_preferred_time: string | null;
  escalation_requested: boolean;
  resolution_state: 'open' | 'in_progress' | 'resolved' | 'unresolved';
  resolved_at: Date | null; resolved_by: string | null; fcr: boolean | null;
  call_values: Record<string, unknown>; raw_payload: Record<string, unknown>;
  created_at: Date; updated_at: Date;
}

export type CallFactsInput = NormalizedCall & {
  tenantId: string; messageId: string; rawPayload: Record<string, unknown>;
};

// Upsert on message_id (1:1 with the inbound call). Re-delivery updates, never duplicates.
export async function upsertCallFacts(pool: pg.Pool, a: CallFactsInput): Promise<void> {
  await pool.query(
    `INSERT INTO call_facts
       (tenant_id, message_id, caller_suid, caller_name, caller_phone, caller_timezone,
        line_ref, attribution_label, call_type, summary, call_outcome, sentiment,
        call_duration_seconds, callback_requested, callback_preferred_time, escalation_requested,
        call_values, raw_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (message_id) DO UPDATE SET
       caller_suid = EXCLUDED.caller_suid, caller_name = EXCLUDED.caller_name,
       caller_phone = EXCLUDED.caller_phone, caller_timezone = EXCLUDED.caller_timezone,
       line_ref = EXCLUDED.line_ref, attribution_label = EXCLUDED.attribution_label,
       call_type = EXCLUDED.call_type, summary = EXCLUDED.summary,
       call_outcome = EXCLUDED.call_outcome, sentiment = EXCLUDED.sentiment,
       call_duration_seconds = EXCLUDED.call_duration_seconds,
       callback_requested = EXCLUDED.callback_requested,
       callback_preferred_time = EXCLUDED.callback_preferred_time,
       escalation_requested = EXCLUDED.escalation_requested,
       call_values = EXCLUDED.call_values, raw_payload = EXCLUDED.raw_payload, updated_at = now()`,
    [a.tenantId, a.messageId, a.callerSuid, a.callerName, a.callerPhone, a.callerTimezone,
     a.lineRef, a.attributionLabel, a.callType, a.summary, a.callOutcome, a.sentiment,
     a.callDurationSeconds, a.callbackRequested, a.callbackPreferredTime, a.escalationRequested,
     JSON.stringify(a.values ?? {}), JSON.stringify(a.rawPayload ?? {})]);
}

export async function getCallFactsByMessage(pool: pg.Pool, messageId: string): Promise<CallFactsRow | null> {
  const r = await pool.query<CallFactsRow>(`SELECT * FROM call_facts WHERE message_id = $1`, [messageId]);
  return r.rows[0] ?? null;
}

// AI-derived classification written by the tagger. Creates a minimal call_facts row if one
// doesn't exist yet (e.g. imported/line-pipeline calls that never went through Jobix ingest),
// otherwise updates only the classification fields. resolution_state is only set from AI when
// it is still 'open' (never clobbers a human disposition set via the Actions UI).
export interface CallClassificationInput {
  tenantId: string; messageId: string;
  callOutcome: string | null; sentiment: string | null;
  callbackRequested: boolean; escalationRequested: boolean;
  resolutionState: 'open' | 'in_progress' | 'resolved' | 'unresolved' | null;
}

export async function upsertCallClassification(pool: pg.Pool, a: CallClassificationInput): Promise<void> {
  await pool.query(
    `INSERT INTO call_facts
       (tenant_id, message_id, call_outcome, sentiment, callback_requested, escalation_requested, resolution_state)
     VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7,'open'))
     ON CONFLICT (message_id) DO UPDATE SET
       call_outcome = EXCLUDED.call_outcome,
       sentiment = EXCLUDED.sentiment,
       callback_requested = EXCLUDED.callback_requested,
       escalation_requested = EXCLUDED.escalation_requested,
       resolution_state = CASE
         WHEN call_facts.resolution_state = 'open' AND $7 IS NOT NULL THEN $7
         ELSE call_facts.resolution_state END,
       updated_at = now()`,
    [a.tenantId, a.messageId, a.callOutcome, a.sentiment, a.callbackRequested, a.escalationRequested, a.resolutionState]);
}
