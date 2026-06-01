import type pg from 'pg';
import type { LlmClient } from '../runner.js';
import { getGoal } from '../../repos/agentGoals.js';
import { findDormantContacts } from '../../repos/agentDormant.js';
import { insertPlay, getPlay, type PlayRow } from '../../repos/agentPlays.js';
import { draftReengagePlay } from './draftPlay.js';
import { scoreRisk, requiresApproval } from './risk.js';
import { getAgentConfig, getAgentOpenAIKey } from '../../repos/agent.js';
import { lastCompletedPlayOutcome } from '../../repos/agentOutcomes.js';
import { startPlayExecution } from './execute.js';
import { escalatePlay } from './escalate.js';

export type ShiftResult =
  | { status: 'executed'; playId: string; audienceSize: number; queued: number }
  | { status: 'pending_approval'; playId: string; audienceSize: number }
  | { status: 'skipped'; reason: 'no_goal' | 'goal_disabled' | 'no_openai_key' | 'no_dormant_contacts' };

export async function runAbeShift(args: {
  pool: pg.Pool;
  encKey: Buffer;
  tenantId: string;
  baseUrl: string;
  llmFactory: (apiKey: string) => LlmClient;
}): Promise<ShiftResult> {
  const { pool, encKey, tenantId } = args;

  const goal = await getGoal(pool, tenantId);
  if (!goal) return { status: 'skipped', reason: 'no_goal' };
  if (!goal.enabled) return { status: 'skipped', reason: 'goal_disabled' };

  const apiKey = await getAgentOpenAIKey(pool, encKey, tenantId);
  if (!apiKey) return { status: 'skipped', reason: 'no_openai_key' };
  const cfg = await getAgentConfig(pool, tenantId);
  const model = cfg?.model ?? 'gpt-4.1';

  const dormant = await findDormantContacts(pool, tenantId, goal.dormant_window_days);
  if (dormant.length === 0) return { status: 'skipped', reason: 'no_dormant_contacts' };

  // Best-effort enrichment — a transient failure here must not abort the shift.
  const priorOutcomeHint = await lastCompletedPlayOutcome(pool, tenantId).catch(() => null);

  const touches = await draftReengagePlay({
    llm: args.llmFactory(apiKey),
    model,
    brandVoice: goal.brand_voice,
    maxTouches: goal.max_touches,
    touchSpacingDays: goal.touch_spacing_days,
    audienceSize: dormant.length,
    priorOutcomeHint,
  });

  const audienceSize = dormant.length;
  const play: PlayRow = await insertPlay(pool, {
    tenantId,
    goalId: goal.id,
    riskScore: scoreRisk({ audienceSize }),
    audienceSnapshot: { contact_ids: dormant.map((c) => c.id), size: audienceSize },
    touches,
  });

  if (requiresApproval(audienceSize, goal.auto_fire_max_audience)) {
    await pool.query(`UPDATE agent_plays SET status = 'pending_approval', updated_at = now() WHERE id = $1`, [play.id]);
    // Best-effort escalation: never let a failure here break the shift.
    try {
      await escalatePlay({ pool, encKey, baseUrl: args.baseUrl, play, goal });
    } catch {
      // escalatePlay itself should not throw for expected no-ops, but guard defensively.
    }
    return { status: 'pending_approval', playId: play.id, audienceSize };
  }
  const fresh = await getPlay(pool, tenantId, play.id);
  const { queued } = await startPlayExecution({ pool, encKey, baseUrl: args.baseUrl, play: fresh! });
  return { status: 'executed', playId: play.id, audienceSize, queued };
}
