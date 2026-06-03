import type pg from 'pg';
import type { McpToolProvider, AgentTool } from '../mcp.js';
import { aggregateByCategory } from '../../repos/lineCallTags.js';
import { listReports, getReport } from '../../repos/lineReports.js';
import { getLineReportConfig, upsertLineReportConfig } from '../../repos/lineReportConfigs.js';
import { countCallsMatching, listCalls } from '../../repos/callAnalytics.js';

const ok = (data: unknown): string => JSON.stringify(data);
const DAY = 86_400_000;

const TOOLS: AgentTool[] = [
  {
    name: 'top_call_reasons',
    description: 'Ranked call categories over the last N days.',
    parameters: { type: 'object', properties: { windowDays: { type: 'number' } } },
  },
  {
    name: 'query_calls',
    description: 'Counts for a category (or all) over the last N days.',
    parameters: { type: 'object', properties: { windowDays: { type: 'number' }, category: { type: 'string' } } },
  },
  {
    name: 'list_reports',
    description: 'Recent ABSA reports with type/status.',
    parameters: { type: 'object', properties: { status: { type: 'string' } } },
  },
  {
    name: 'get_report',
    description: 'A report by id (latest if omitted).',
    parameters: { type: 'object', properties: { id: { type: 'string' } } },
  },
  {
    name: 'get_report_settings',
    description: 'Current line-report config.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'draft_report',
    description: 'Draft an ABSA report (digest/answer). Creates a pending_approval draft; never sends.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string' },
        windowDays: { type: 'number' },
        question: { type: 'string' },
      },
    },
  },
  {
    name: 'update_report_settings',
    description: 'Update cadence/recipients/taxonomy/thresholds (clamped).',
    parameters: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        recipients: { type: 'array', items: { type: 'string' } },
        spikePct: { type: 'number' },
        spikeMinCount: { type: 'number' },
      },
    },
  },
  {
    name: 'search_calls',
    description: 'Count + sample inbound calls whose summary text matches a phrase over the last N days.',
    parameters: { type: 'object', properties: { text: { type: 'string' }, windowDays: { type: 'number' } } },
  },
];

interface LlmLike {
  chat(a: { model: string; messages: Array<{ role: string; content: string }> }): Promise<{ content: string }>;
}

export function makeLineChatProvider(ctx: {
  pool: pg.Pool;
  tenantId: string;
  llm?: LlmLike;
  model?: string;
}): McpToolProvider {
  const { pool, tenantId } = ctx;

  return {
    async listTools(): Promise<AgentTool[]> {
      return TOOLS;
    },

    async close(): Promise<void> {
      /* no resources to release */
    },

    async callTool(name: string, args: Record<string, unknown>): Promise<string> {
      const win = (d: unknown) => new Date(Date.now() - (Number(d) || 7) * DAY);
      // Add a small buffer to account for clock skew between the JS process and the database server.
      const end = () => new Date(Date.now() + 5_000);

      switch (name) {
        case 'top_call_reasons':
        case 'query_calls': {
          const agg = await aggregateByCategory(pool, tenantId, win(args.windowDays), end());
          const cat = args.category as string | undefined;
          return ok(cat ? agg.filter(a => a.category === cat) : agg);
        }

        case 'list_reports':
          return ok(await listReports(pool, tenantId, args.status as any));

        case 'get_report':
          return ok(await getReport(pool, tenantId, (args.id as string) ?? ''));

        case 'get_report_settings':
          return ok(await getLineReportConfig(pool, tenantId));

        case 'update_report_settings':
          return ok(await upsertLineReportConfig(pool, tenantId, args as any));

        case 'draft_report': {
          if (!ctx.llm || !ctx.model) return ok({ error: 'no_model' });
          const { composeDigest, composeAnswer } = await import('./lineCompose.js');
          if (args.type === 'answer' && args.question) {
            const r = await composeAnswer({
              pool,
              tenantId,
              llm: ctx.llm,
              model: ctx.model,
              question: String(args.question),
              start: win(args.windowDays),
              end: end(),
            });
            return ok({ queued: true, reportId: r.id });
          }
          const r = await composeDigest({
            pool,
            tenantId,
            llm: ctx.llm,
            model: ctx.model,
            periodLabel: 'daily',
            start: win(args.windowDays),
            end: end(),
          });
          return ok({ queued: true, reportId: r.id });
        }

        case 'search_calls': {
          const text = String(args.text ?? '');
          if (!text) return ok({ count: 0, examples: [] });
          const start = win(args.windowDays), endDate = end();
          const count = await countCallsMatching(pool, tenantId, text, start, endDate);
          const { calls } = await listCalls(pool, tenantId, { search: text, from: start, to: endDate, limit: 5 });
          return ok({ count, examples: calls.map(c => ({ id: c.id, category: c.category, excerpt: c.content.slice(0, 160) })) });
        }

        default:
          return ok({ error: `unknown tool: ${name}` });
      }
    },
  };
}
