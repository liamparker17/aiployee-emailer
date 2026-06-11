import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { AppError } from '@aiployee/core';

export type FlowStatus = 'draft' | 'active' | 'paused' | 'archived';
export type StepKind = 'wait' | 'jobix_call' | 'email' | 'condition' | 'whatsapp_send';
export type EnrollmentStatus = 'active' | 'completed' | 'exited' | 'failed';

export interface FlowRow {
  id: string; tenant_id: string; name: string; status: FlowStatus;
  created_by: string | null; created_at: Date; updated_at: Date;
}
export interface FlowStepRow {
  id: string; tenant_id: string; flow_id: string; position: number;
  kind: StepKind; config: Record<string, unknown>; created_at: Date; updated_at: Date;
}
export interface EnrollmentRow {
  id: string; tenant_id: string; flow_id: string; contact_id: string | null;
  name: string; phone: string; email: string; context: Record<string, unknown>;
  status: EnrollmentStatus; current_position: number; next_run_at: Date | null;
  last_error: string | null; created_at: Date; updated_at: Date;
}
export interface FlowWithCounts extends FlowRow {
  step_count: number; total_enrollments: number; active_enrollments: number; completed_enrollments: number;
}

// ── Flows ────────────────────────────────────────────────────────────────────

export async function createFlow(pool: pg.Pool, input: { tenantId: string; name: string; createdBy?: string }): Promise<FlowRow> {
  const r = await pool.query<FlowRow>(
    `INSERT INTO flows (tenant_id, name, created_by) VALUES ($1,$2,$3) RETURNING *`,
    [input.tenantId, input.name, input.createdBy ?? null]);
  return r.rows[0];
}

export async function listFlows(pool: pg.Pool, tenantId: string): Promise<FlowWithCounts[]> {
  const r = await pool.query<FlowWithCounts>(
    `SELECT f.*,
       (SELECT count(*) FROM flow_steps s WHERE s.flow_id = f.id)::int AS step_count,
       (SELECT count(*) FROM flow_enrollments e WHERE e.flow_id = f.id)::int AS total_enrollments,
       (SELECT count(*) FROM flow_enrollments e WHERE e.flow_id = f.id AND e.status = 'active')::int AS active_enrollments,
       (SELECT count(*) FROM flow_enrollments e WHERE e.flow_id = f.id AND e.status = 'completed')::int AS completed_enrollments
     FROM flows f WHERE f.tenant_id = $1 ORDER BY f.created_at DESC`, [tenantId]);
  return r.rows;
}

export async function getFlow(pool: pg.Pool, tenantId: string, id: string): Promise<{ flow: FlowRow; steps: FlowStepRow[] } | null> {
  const f = await pool.query<FlowRow>(`SELECT * FROM flows WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  if (!f.rows[0]) return null;
  const steps = await listSteps(pool, tenantId, id);
  return { flow: f.rows[0], steps };
}

async function transition(pool: pg.Pool, tenantId: string, id: string, from: FlowStatus[], to: FlowStatus): Promise<FlowRow> {
  const r = await pool.query<FlowRow>(
    `UPDATE flows SET status = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND status = ANY($4) RETURNING *`,
    [tenantId, id, to, from]);
  if (!r.rows[0]) {
    const exists = await pool.query(`SELECT status FROM flows WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
    if (!exists.rows[0]) throw new AppError('not_found', 404, 'Flow not found');
    throw new AppError('invalid_transition', 400, `Cannot move flow from ${exists.rows[0].status} to ${to}`);
  }
  return r.rows[0];
}

export async function activateFlow(pool: pg.Pool, tenantId: string, id: string): Promise<FlowRow> {
  const steps = await listSteps(pool, tenantId, id);
  if (steps.length === 0) throw new AppError('no_steps', 400, 'Add at least one step before activating');
  return transition(pool, tenantId, id, ['draft', 'paused'], 'active');
}
export const pauseFlow = (pool: pg.Pool, tenantId: string, id: string) => transition(pool, tenantId, id, ['active'], 'paused');
export const archiveFlow = (pool: pg.Pool, tenantId: string, id: string) => transition(pool, tenantId, id, ['draft', 'active', 'paused'], 'archived');

export async function renameFlow(pool: pg.Pool, tenantId: string, id: string, name: string): Promise<FlowRow | null> {
  const r = await pool.query<FlowRow>(`UPDATE flows SET name = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING *`, [tenantId, id, name]);
  return r.rows[0] ?? null;
}

// ── Steps ────────────────────────────────────────────────────────────────────

export async function listSteps(pool: pg.Pool, tenantId: string, flowId: string): Promise<FlowStepRow[]> {
  const r = await pool.query<FlowStepRow>(
    `SELECT * FROM flow_steps WHERE tenant_id = $1 AND flow_id = $2 ORDER BY position`, [tenantId, flowId]);
  return r.rows;
}

// Replace the whole ordered step list for a flow (the builder posts the full list).
export async function replaceSteps(pool: pg.Pool, tenantId: string, flowId: string, steps: Array<{ kind: StepKind; config: Record<string, unknown> }>): Promise<FlowStepRow[]> {
  const owns = await pool.query(`SELECT id FROM flows WHERE tenant_id = $1 AND id = $2`, [tenantId, flowId]);
  if (!owns.rows[0]) throw new AppError('not_found', 404, 'Flow not found');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM flow_steps WHERE tenant_id = $1 AND flow_id = $2`, [tenantId, flowId]);
    for (let i = 0; i < steps.length; i++) {
      await client.query(
        `INSERT INTO flow_steps (tenant_id, flow_id, position, kind, config) VALUES ($1,$2,$3,$4,$5)`,
        [tenantId, flowId, i, steps[i].kind, JSON.stringify(steps[i].config ?? {})]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return listSteps(pool, tenantId, flowId);
}

// ── Enrollments ──────────────────────────────────────────────────────────────

export interface EnrollRecipient { name: string; phone: string; email?: string; context?: Record<string, unknown>; contactId?: string | null }

export async function enroll(pool: pg.Pool, args: { tenantId: string; flowId: string; recipients: EnrollRecipient[] }): Promise<{ added: number; errors: string[] }> {
  const owns = await pool.query(`SELECT id FROM flows WHERE tenant_id = $1 AND id = $2`, [args.tenantId, args.flowId]);
  if (!owns.rows[0]) throw new AppError('not_found', 404, 'Flow not found');
  const errors: string[] = []; let added = 0;
  for (let i = 0; i < args.recipients.length; i++) {
    const r = args.recipients[i];
    const name = (r.name ?? '').trim(); const phone = (r.phone ?? '').trim();
    if (!name && !phone) { errors.push(`Row ${i + 1}: missing name and phone`); continue; }
    await pool.query(
      `INSERT INTO flow_enrollments (tenant_id, flow_id, contact_id, name, phone, email, context)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [args.tenantId, args.flowId, r.contactId ?? null, name, phone, (r.email ?? '').trim(), JSON.stringify(r.context ?? {})]);
    added++;
  }
  return { added, errors };
}

export async function enrollmentCounts(pool: pg.Pool, tenantId: string, flowId: string): Promise<Record<EnrollmentStatus, number>> {
  const r = await pool.query<{ status: EnrollmentStatus; n: string }>(
    `SELECT status, count(*)::text n FROM flow_enrollments WHERE tenant_id = $1 AND flow_id = $2 GROUP BY status`, [tenantId, flowId]);
  const counts: Record<EnrollmentStatus, number> = { active: 0, completed: 0, exited: 0, failed: 0 };
  for (const row of r.rows) counts[row.status] = Number(row.n);
  return counts;
}

export async function listEnrollments(pool: pg.Pool, tenantId: string, flowId: string, opts: { status?: EnrollmentStatus; limit?: number; offset?: number }): Promise<{ enrollments: EnrollmentRow[]; total: number }> {
  const params: unknown[] = [tenantId, flowId];
  let where = `tenant_id = $1 AND flow_id = $2`;
  if (opts.status) { params.push(opts.status); where += ` AND status = $${params.length}`; }
  const total = await pool.query<{ n: string }>(`SELECT count(*)::text n FROM flow_enrollments WHERE ${where}`, params);
  params.push(opts.limit ?? 100, opts.offset ?? 0);
  const r = await pool.query<EnrollmentRow>(
    `SELECT * FROM flow_enrollments WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { enrollments: r.rows, total: Number(total.rows[0].n) };
}

// ── Engine helpers ───────────────────────────────────────────────────────────

// Claim a batch of due enrollments belonging to ACTIVE flows. Safe under concurrent ticks.
export async function claimDueEnrollments(pool: pg.Pool, batchSize: number): Promise<EnrollmentRow[]> {
  const r = await pool.query<EnrollmentRow>(
    `UPDATE flow_enrollments e SET updated_at = now()
     WHERE e.id IN (
       SELECT e2.id FROM flow_enrollments e2
       JOIN flows f ON f.id = e2.flow_id
       WHERE e2.status = 'active' AND f.status = 'active'
         AND (e2.next_run_at IS NULL OR e2.next_run_at <= now())
       ORDER BY e2.next_run_at NULLS FIRST, e2.created_at
       LIMIT $1
       FOR UPDATE OF e2 SKIP LOCKED
     )
     RETURNING e.*`, [batchSize]);
  return r.rows;
}

export async function saveEnrollmentProgress(pool: pg.Pool, id: string, p: { currentPosition: number; status: EnrollmentStatus; nextRunAt: Date | null; lastError: string | null }): Promise<void> {
  await pool.query(
    `UPDATE flow_enrollments SET current_position = $2, status = $3, next_run_at = $4, last_error = $5, updated_at = now() WHERE id = $1`,
    [id, p.currentPosition, p.status, p.nextRunAt, p.lastError ? p.lastError.slice(0, 2000) : null]);
}

// suid-style id for any downstream use (kept stable per enrollment if needed later)
export const newEnrollmentRef = (): string => randomUUID();
