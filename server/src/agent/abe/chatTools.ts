import type pg from 'pg';
import type { LlmFactory } from '../runner.js';
import type { McpToolProvider, AgentTool } from '../mcp.js';
import { getGoal, upsertGoal, type GoalPatch } from '../../repos/agentGoals.js';
import { findDormantContacts } from '../../repos/agentDormant.js';
import { listPlays, getPlay } from '../../repos/agentPlays.js';
import { getPlayOutcomes } from '../../repos/agentOutcomes.js';
import { getDefaultSender } from '../../repos/senders.js';
import { getAgentOpenAIKey } from '../../repos/agent.js';
import { runAbeShift } from './shift.js';

const clamp = (n: unknown, min: number, max: number, dflt: number): number => {
  const x = Math.round(Number(n));
  return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : dflt;
};
const ok = (data: unknown): string => JSON.stringify(data);

const TOOLS: AgentTool[] = [
  {
    name: 'get_status',
    description: "Abe's current state: whether he's enabled, and readiness (OpenAI key + default sender present).",
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'count_dormant',
    description: 'How many contacts are currently dormant for the configured window.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'list_plays',
    description: 'Recent re-engagement plays with their status and audience size.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_play_outcomes',
    description: 'Engagement outcomes (sends/opens/clicks/reactivations) for a play id.',
    parameters: { type: 'object', properties: { playId: { type: 'string' } }, required: ['playId'] },
  },
  {
    name: 'get_settings',
    description: "Abe's current goal configuration.",
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'update_settings',
    description: "Update Abe's working limits / settings. Values are clamped to allowed ranges.",
    parameters: {
      type: 'object',
      properties: {
        dormantWindowDays: { type: 'number' },
        autoFireMaxAudience: { type: 'number' },
        maxTouches: { type: 'number' },
        touchSpacingDays: { type: 'number' },
        brandVoice: { type: 'string' },
        lineManagerEmail: { type: 'string' },
      },
    },
  },
  {
    name: 'pause_abe',
    description: 'Pause Abe (he stops running shifts).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'resume_abe',
    description: 'Resume Abe.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'trigger_shift',
    description:
      'Run a shift now: find dormant contacts and PROPOSE a re-engagement play. This never sends email by itself — large plays wait for human approval.',
    parameters: { type: 'object', properties: {} },
  },
];

export function makeAbeChatProvider(ctx: {
  pool: pg.Pool;
  encKey: Buffer;
  tenantId: string;
  baseUrl: string;
  llmFactory: LlmFactory;
}): McpToolProvider {
  const { pool, encKey, tenantId, baseUrl, llmFactory } = ctx;
  return {
    async listTools() {
      return TOOLS;
    },
    async close() {
      /* no resources to release */
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<string> {
      switch (name) {
        case 'get_status': {
          const goal = await getGoal(pool, tenantId);
          const hasKey = !!(await getAgentOpenAIKey(pool, encKey, tenantId));
          const hasSender = !!(await getDefaultSender(pool, tenantId));
          return ok({ hired: !!goal, enabled: !!goal?.enabled, hasOpenAiKey: hasKey, hasDefaultSender: hasSender });
        }
        case 'count_dormant': {
          const goal = await getGoal(pool, tenantId);
          const dormant = goal ? await findDormantContacts(pool, tenantId, goal.dormant_window_days) : [];
          return ok({ dormant: dormant.length, windowDays: goal?.dormant_window_days ?? null });
        }
        case 'list_plays': {
          const plays = await listPlays(pool, tenantId);
          return ok(plays.map(p => ({ id: p.id, status: p.status, audience: p.audience_snapshot.size, createdAt: p.created_at })));
        }
        case 'get_play_outcomes': {
          const playId = String((args as { playId?: string }).playId ?? '');
          const play = await getPlay(pool, tenantId, playId);
          if (!play) return ok({ error: 'play not found' });
          return ok({ status: play.status, outcomes: await getPlayOutcomes(pool, tenantId, playId) });
        }
        case 'get_settings': {
          const goal = await getGoal(pool, tenantId);
          return ok(goal ?? { error: 'Abe is not hired yet' });
        }
        case 'update_settings': {
          const a = args as Record<string, unknown>;
          const patch: GoalPatch = {};
          if ('dormantWindowDays' in a) patch.dormantWindowDays = clamp(a.dormantWindowDays, 1, 3650, 60);
          if ('autoFireMaxAudience' in a) patch.autoFireMaxAudience = clamp(a.autoFireMaxAudience, 0, 100000, 0);
          if ('maxTouches' in a) patch.maxTouches = clamp(a.maxTouches, 1, 5, 3);
          if ('touchSpacingDays' in a) patch.touchSpacingDays = clamp(a.touchSpacingDays, 1, 60, 3);
          if (typeof a.brandVoice === 'string') patch.brandVoice = a.brandVoice.slice(0, 2000);
          if (typeof a.lineManagerEmail === 'string') patch.lineManagerEmail = a.lineManagerEmail;
          const goal = await upsertGoal(pool, tenantId, patch);
          return ok({ updated: true, settings: goal });
        }
        case 'pause_abe': {
          const g = await upsertGoal(pool, tenantId, { enabled: false });
          return ok({ enabled: g.enabled });
        }
        case 'resume_abe': {
          const g = await upsertGoal(pool, tenantId, { enabled: true });
          return ok({ enabled: g.enabled });
        }
        case 'trigger_shift': {
          const r = await runAbeShift({ pool, encKey, tenantId, baseUrl, llmFactory });
          return ok(r);
        }
        default:
          return ok({ error: `unknown tool: ${name}` });
      }
    },
  };
}
