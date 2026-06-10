import type pg from 'pg';
import type { LlmClient } from '../runner.js';
import { makeEmbedBatch } from '../runner.js';
import type { McpToolProvider, AgentTool } from '../mcp.js';
import { CALL_BATCH_MODEL } from './models.js';
import { analyzeCampaign, type BatchEmbed } from './campaignAnalysis.js';
import { draftGroupResponse } from './draftGroupResponse.js';
import {
  latestAnalysis, listReplyGroups, searchInbox, getInboundEmail,
} from '../../repos/campaignAnalyses.js';
import { listCampaigns } from '../../repos/campaigns.js';

const ok = (data: unknown): string => JSON.stringify(data);

const TOOLS: AgentTool[] = [
  {
    name: 'analyze_campaign',
    description:
      'Run (or refresh) the reply analysis for a campaign: funnel (sent → opened → replied → hot leads) plus reply groups — ' +
      'replies clustered by the response they require, each with a proposed outline. Accepts a campaign id or a name fragment.',
    parameters: { type: 'object', properties: { campaign: { type: 'string', description: 'Campaign id or name (fragment ok)' } }, required: ['campaign'] },
  },
  {
    name: 'get_campaign_groups',
    description: 'Latest reply analysis for a campaign without re-running it: funnel snapshot and groups (label, size, confidence, proposed outline).',
    parameters: { type: 'object', properties: { campaign: { type: 'string', description: 'Campaign id or name (fragment ok)' } }, required: ['campaign'] },
  },
  {
    name: 'search_inbox',
    description: 'Search received (inbound) emails — replies and other mail synced from monitored mailboxes — by text.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, days: { type: 'number', description: 'Look-back window, default 90' } },
      required: ['query'],
    },
  },
  {
    name: 'get_reply',
    description: 'Full content of one inbound email by id, including correlation (campaign/contact) and group assignment.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'draft_group_response',
    description:
      'Queue your drafted response to a reply group into the human approval flow (nothing sends without approval). ' +
      'mode "batch" = one email to every member of the group (one approval). mode "individual" = a separate, per-recipient ' +
      'personalised draft for each member (approved one by one; required for hot leads). ' +
      'ALWAYS ask the user which mode they want before calling this.',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string' },
        mode: { type: 'string', enum: ['batch', 'individual'] },
        subject: { type: 'string' },
        bodyHtml: { type: 'string', description: 'The drafted response body as simple HTML' },
      },
      required: ['groupId', 'mode', 'subject', 'bodyHtml'],
    },
  },
];

export function makeInboxChatProvider(ctx: {
  pool: pg.Pool;
  encKey: Buffer;
  baseUrl: string;
  tenantId: string;
  apiKey: string;
  llm: LlmClient;
  embed?: BatchEmbed; // injectable for tests
}): McpToolProvider {
  const { pool, encKey, baseUrl, tenantId, apiKey, llm } = ctx;
  const embed = ctx.embed ?? makeEmbedBatch(apiKey);

  async function resolveCampaign(ref: string): Promise<{ id: string; name: string } | null> {
    const campaigns = await listCampaigns(pool, tenantId);
    const byId = campaigns.find(c => c.id === ref);
    if (byId) return { id: byId.id, name: byId.name };
    const needle = ref.trim().toLowerCase();
    const matches = campaigns.filter(c => c.name.toLowerCase().includes(needle));
    return matches.length === 1 ? { id: matches[0].id, name: matches[0].name } : null;
  }

  return {
    async listTools() { return TOOLS; },
    async close() { /* no resources to release */ },
    async callTool(name: string, args: Record<string, unknown>): Promise<string> {
      switch (name) {
        case 'analyze_campaign': {
          const campaign = await resolveCampaign(String(args.campaign ?? ''));
          if (!campaign) return ok({ error: 'campaign not found or ambiguous — ask the user which campaign they mean' });
          const r = await analyzeCampaign({ pool, tenantId, campaignId: campaign.id, embed, llm, model: CALL_BATCH_MODEL });
          return ok({
            campaign: campaign.name, funnel: r.funnel,
            groups: r.groups.map(g => ({
              id: g.id, label: g.label, kind: g.kind, size: g.size,
              confidence: g.confidence, intent: g.intent_summary, proposedOutline: g.proposed_outline,
            })),
          });
        }
        case 'get_campaign_groups': {
          const campaign = await resolveCampaign(String(args.campaign ?? ''));
          if (!campaign) return ok({ error: 'campaign not found or ambiguous' });
          const analysis = await latestAnalysis(pool, tenantId, campaign.id);
          if (!analysis) return ok({ error: 'no analysis yet — run analyze_campaign first' });
          const groups = await listReplyGroups(pool, tenantId, analysis.id);
          return ok({
            campaign: campaign.name, runAt: analysis.run_at, status: analysis.status,
            funnel: {
              sent: analysis.sent_count, opened: analysis.opened_count,
              replied: analysis.replied_count, hotLeads: analysis.hot_lead_count,
            },
            groups: groups.map(g => ({
              id: g.id, label: g.label, kind: g.kind, size: g.size,
              confidence: g.confidence, intent: g.intent_summary, proposedOutline: g.proposed_outline,
              sendMode: g.send_mode, draftStatus: g.draft_status,
            })),
          });
        }
        case 'search_inbox': {
          const query = String(args.query ?? '').trim();
          if (!query) return ok({ error: 'query required' });
          const days = typeof args.days === 'number' ? args.days : undefined;
          return ok({ results: await searchInbox(pool, tenantId, { query, days }) });
        }
        case 'get_reply': {
          const reply = await getInboundEmail(pool, tenantId, String(args.id ?? ''));
          return ok(reply ?? { error: 'not found' });
        }
        case 'draft_group_response': {
          const mode = String(args.mode ?? '');
          if (mode !== 'batch' && mode !== 'individual') return ok({ error: 'mode must be batch or individual' });
          const subject = String(args.subject ?? '').trim();
          const bodyHtml = String(args.bodyHtml ?? '').trim();
          if (!subject || !bodyHtml) return ok({ error: 'subject and bodyHtml required' });
          const r = await draftGroupResponse({
            pool, encKey, baseUrl, tenantId,
            groupId: String(args.groupId ?? ''), mode, subject, bodyHtml, llm,
          });
          return ok(r);
        }
        default:
          return ok({ error: `unknown tool: ${name}` });
      }
    },
  };
}
