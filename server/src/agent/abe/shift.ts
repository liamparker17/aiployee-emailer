import type pg from 'pg';
import type { LlmClient } from '../runner.js';
import { getGoal } from '../../repos/agentGoals.js';
import { findDormantContacts } from '../../repos/agentDormant.js';
import { insertPlay, type PlayRow } from '../../repos/agentPlays.js';
import { draftReengagePlay } from './draftPlay.js';
import { scoreRisk } from './risk.js';
import { getAgentConfig, getAgentOpenAIKey } from '../../repos/agent.js';

export type ShiftResult =
  | { status: 'proposed'; playId: string; audienceSize: number }
  | { status: 'skipped'; reason: 'no_goal' | 'goal_disabled' | 'no_openai_key' | 'no_dormant_contacts' };

export async function runAbeShift(args: {
  pool: pg.Pool;
  encKey: Buffer;
  tenantId: string;
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

  const touches = await draftReengagePlay({
    llm: args.llmFactory(apiKey),
    model,
    brandVoice: goal.brand_voice,
    maxTouches: goal.max_touches,
    touchSpacingDays: goal.touch_spacing_days,
    audienceSize: dormant.length,
  });

  const play: PlayRow = await insertPlay(pool, {
    tenantId,
    goalId: goal.id,
    riskScore: scoreRisk({ audienceSize: dormant.length }),
    audienceSnapshot: { contact_ids: dormant.map((c) => c.id), size: dormant.length },
    touches,
  });

  return { status: 'proposed', playId: play.id, audienceSize: dormant.length };
}
