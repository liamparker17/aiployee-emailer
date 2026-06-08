import type pg from 'pg';
import {
  claimDueEnrollments, listSteps, saveEnrollmentProgress,
  type EnrollmentRow, type EnrollmentStatus, type FlowStepRow,
} from '../repos/flows.js';
import { fireTrigger, type FireResult } from '../jobix/fireTrigger.js';

// The flow step that fires a Jobix call reuses the fireTrigger primitive (jobix_triggers).
// Injectable so tests never hit real HTTP.
export type FireFn = (
  pool: pg.Pool, encKey: Buffer,
  args: { tenantId: string; triggerId: string; vars: Record<string, string>; source: 'event'; userId: string | null },
) => Promise<FireResult>;

export interface FlowQueueOpts { batchSize: number; maxStepsPerTick: number }
export interface FlowQueueSummary { claimed: number; advanced: number; completed: number; failed: number; exited: number; calls: number }

function buildVars(e: EnrollmentRow): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(e.context ?? {})) out[k] = v == null ? '' : String(v);
  out.name = e.name; out.phone = e.phone; if (e.email) out.email = e.email;
  return out;
}

function waitMs(config: Record<string, unknown>): number {
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return (n(config.days) * 86_400 + n(config.hours) * 3_600 + n(config.minutes) * 60) * 1000;
}

function evalCondition(config: Record<string, unknown>, vars: Record<string, string>): boolean {
  const field = String(config.field ?? '');
  const op = String(config.op ?? 'exists');
  const v = vars[field];
  const present = v !== undefined && v !== '';
  switch (op) {
    case 'exists': return present;
    case 'not_exists': return !present;
    case 'eq': return (v ?? '') === String(config.value ?? '');
    case 'neq': return (v ?? '') !== String(config.value ?? '');
    default: return true;
  }
}

export async function runFlowQueue(
  pool: pg.Pool, encKey: Buffer, opts: FlowQueueOpts, fire: FireFn = fireTrigger,
): Promise<FlowQueueSummary> {
  const claimed = await claimDueEnrollments(pool, opts.batchSize);
  const summary: FlowQueueSummary = { claimed: claimed.length, advanced: 0, completed: 0, failed: 0, exited: 0, calls: 0 };
  const stepsCache = new Map<string, FlowStepRow[]>();

  for (const e of claimed) {
    let steps = stepsCache.get(e.flow_id);
    if (!steps) { steps = await listSteps(pool, e.tenant_id, e.flow_id); stepsCache.set(e.flow_id, steps); }
    const vars = buildVars(e);

    let pos = e.current_position;
    let status: EnrollmentStatus = 'active';
    let nextRunAt: Date | null = null;
    let lastError: string | null = null;
    let iterations = 0;

    while (true) {
      if (iterations++ > opts.maxStepsPerTick) { nextRunAt = new Date(); break; } // resume next tick
      if (pos >= steps.length) { status = 'completed'; summary.completed++; break; }
      const step = steps[pos];
      const cfg = step.config ?? {};

      if (step.kind === 'wait') {
        nextRunAt = new Date(Date.now() + waitMs(cfg));
        pos += 1;
        break; // parked until the delay elapses
      } else if (step.kind === 'jobix_call') {
        const triggerId = String(cfg.triggerId ?? '');
        if (!triggerId) { status = 'failed'; lastError = 'jobix_call step is missing triggerId'; summary.failed++; break; }
        try {
          await fire(pool, encKey, { tenantId: e.tenant_id, triggerId, vars, source: 'event', userId: null });
          summary.calls++;
        } catch (err) {
          status = 'failed'; lastError = err instanceof Error ? err.message : String(err); summary.failed++; break;
        }
        pos += 1;
      } else if (step.kind === 'condition') {
        if (evalCondition(cfg, vars)) { pos += 1; }
        else if (String(cfg.onFail ?? 'exit') === 'continue') { pos += 1; }
        else { status = 'exited'; summary.exited++; break; }
      } else {
        // 'email' (not implemented in v1) or unknown — skip safely.
        pos += 1;
      }
    }

    if (status === 'active' && pos !== e.current_position) summary.advanced++;
    await saveEnrollmentProgress(pool, e.id, { currentPosition: pos, status, nextRunAt, lastError });
  }

  return summary;
}
