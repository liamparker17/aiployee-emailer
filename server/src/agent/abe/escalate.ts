import type pg from 'pg';
import type { PlayRow } from '../../repos/agentPlays.js';
import type { GoalRow } from '../../repos/agentGoals.js';
import { getActiveApprovalByPlay } from '../../repos/agentApprovals.js';
import { sendApprovalEmail } from './approvalEmail.js';

export type EscalateResult =
  | { escalated: true; emailId: string }
  | { escalated: false; reason: 'no_manager_email' | 'manager_unverified' | 'already_escalated' | 'no_default_sender' };

/**
 * Idempotent escalation: emails the verified line manager an approval link for a
 * pending_approval play and records the approval row. No-op (never throws) for the
 * expected "can't escalate" conditions so the in-app approve/reject fallback stands.
 */
export async function escalatePlay(args: {
  pool: pg.Pool; encKey: Buffer; baseUrl: string; play: PlayRow; goal: GoalRow;
}): Promise<EscalateResult> {
  const { goal, play } = args;
  if (!goal.line_manager_email) return { escalated: false, reason: 'no_manager_email' };
  if (!goal.line_manager_verified_at) return { escalated: false, reason: 'manager_unverified' };

  const existing = await getActiveApprovalByPlay(args.pool, play.id);
  if (existing) return { escalated: false, reason: 'already_escalated' };

  const res = await sendApprovalEmail({
    pool: args.pool, encKey: args.encKey, baseUrl: args.baseUrl,
    tenantId: play.tenant_id, play, managerEmail: goal.line_manager_email,
  });
  if (!res.sent) return { escalated: false, reason: 'no_default_sender' };
  return { escalated: true, emailId: res.emailId! };
}
