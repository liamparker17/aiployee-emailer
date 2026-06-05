import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { AppError, sendError } from '../util/errors.js';
import { listCalls, listCallsForExport, getCall, breakdownByCategory, callsPerDay, callAnalyticsSummary, breakdownBy, crosstabDeptCategory } from '../repos/callAnalytics.js';
import { getLineReportConfig, upsertLineReportConfig } from '../repos/lineReportConfigs.js';
import { suggestCategories } from '../agent/abe/categorySuggest.js';
import { retagCalls } from '../agent/abe/retag.js';
import { backfillCallsFromEmails } from '../agent/abe/backfillCalls.js';
import { setupCategories } from '../agent/abe/setupCategories.js';
import { getAgentOpenAIKey, getAgentConfig } from '../repos/agent.js';
import { openAiFactory } from '../agent/runner.js';

function requireAdmin(ctx: ReturnType<typeof requireTenantCtx>): void {
  if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') {
    throw new AppError('forbidden', 403, 'Admin role required');
  }
}

const WINDOWS: Record<string, number> = { today: 1, '7d': 7, '30d': 30 };

function windowRange(w: string): { start: Date; end: Date } {
  const days = WINDOWS[w] ?? 7;
  const end = new Date();
  const start = w === 'today'
    ? new Date(new Date().setHours(0, 0, 0, 0))
    : new Date(end.getTime() - days * 86_400_000);
  return { start, end };
}

async function tenantLlm(app: FastifyInstance, tenantId: string) {
  const key = await getAgentOpenAIKey(app.pool, app.cfg.encKey, tenantId);
  const factory = (app.agentLlmFactory ?? openAiFactory) as unknown as
    (k?: string) => { chat(a: { model: string; messages: Array<{ role: string; content: string }> }): Promise<{ content: string }> };
  const cfg = await getAgentConfig(app.pool, tenantId);
  if (!key && !app.agentLlmFactory) throw new AppError('no_openai_key', 400, 'Connect an OpenAI key first.');
  return { llm: factory(key ?? undefined), model: cfg?.model ?? 'gpt-4o' };
}

export function registerCallAnalyticsRoutes(app: FastifyInstance): void {
  // ── List calls ─────────────────────────────────────────────────────────────

  const ListCallsQ = z.object({
    category: z.string().optional(),
    search: z.string().optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    limit: z.coerce.number().optional(),
    offset: z.coerce.number().optional(),
    attribution: z.string().optional(),
    outcome: z.string().optional(),
    sentiment: z.string().optional(),
    resolution: z.string().optional(),
    callbackRequested: z.coerce.boolean().optional(),
    escalationRequested: z.coerce.boolean().optional(),
    sort: z.enum(['created_at', 'attribution_label', 'category', 'call_outcome', 'sentiment', 'call_duration_seconds', 'resolution_state']).optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
  });

  app.get('/api/calls', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      requireAdmin(ctx);
      const Q = ListCallsQ.parse(req.query);
      const out = await listCalls(app.pool, ctx.tenantId, Q);
      reply.send(out);
    } catch (e) { sendError(reply, e); }
  });

  // ── Export CSV (MUST be before /:id) ──────────────────────────────────────

  function csvCell(v: unknown): string {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  app.get('/api/calls/export.csv', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      requireAdmin(ctx);
      const Q = ListCallsQ.parse(req.query);
      const calls = await listCallsForExport(app.pool, ctx.tenantId, Q);
      const header = ['Time','Caller','Phone','Department','Type','Category','Outcome','Sentiment','Duration','Callback','Escalation','Resolution','Summary'];
      const lines = [header.join(',')];
      for (const c of calls) lines.push([
        c.created_at instanceof Date ? c.created_at.toISOString() : String(c.created_at),
        c.caller_name, c.caller_phone, c.attribution_label, c.call_type, c.category,
        c.call_outcome, c.sentiment, c.call_duration_seconds,
        c.callback_requested ? 'yes' : '', c.escalation_requested ? 'yes' : '',
        c.resolution_state, (c.content ?? '').replace(/\s+/g, ' ').slice(0, 500),
      ].map(csvCell).join(','));
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', 'attachment; filename="calls.csv"');
      return reply.send(lines.join('\n'));
    } catch (e) { sendError(reply, e); }
  });

  // ── Breakdown (MUST be before /:id) ────────────────────────────────────────

  app.get('/api/calls/breakdown', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      requireAdmin(ctx);
      const w = (req.query as Record<string, string>).window ?? '7d';
      const { start, end } = windowRange(w);
      const [summary, byCategoryLegacy, byDepartment, byOutcome, bySentiment, byResolution, crosstab, perDay] = await Promise.all([
        callAnalyticsSummary(app.pool, ctx.tenantId, start, end),
        breakdownByCategory(app.pool, ctx.tenantId, start, end),
        breakdownBy(app.pool, ctx.tenantId, 'attribution_label', start, end),
        breakdownBy(app.pool, ctx.tenantId, 'call_outcome', start, end),
        breakdownBy(app.pool, ctx.tenantId, 'sentiment', start, end),
        breakdownBy(app.pool, ctx.tenantId, 'resolution_state', start, end),
        crosstabDeptCategory(app.pool, ctx.tenantId, start, end),
        callsPerDay(app.pool, ctx.tenantId, start, end),
      ]);
      const byCategory = byCategoryLegacy;
      reply.send({ window: w, total: summary.total, summary, byCategory, byDepartment, byOutcome, bySentiment, byResolution, crosstab, perDay });
    } catch (e) { sendError(reply, e); }
  });

  // ── Categories (MUST be before /:id) ──────────────────────────────────────

  app.get('/api/calls/categories', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      requireAdmin(ctx);
      const cfg = await getLineReportConfig(app.pool, ctx.tenantId);
      reply.send({ categories: cfg?.taxonomy ?? [] });
    } catch (e) { sendError(reply, e); }
  });

  app.put('/api/calls/categories', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      requireAdmin(ctx);
      const body = z.object({ categories: z.array(z.string().min(1)).max(30) }).parse(req.body);
      const cfg = await upsertLineReportConfig(app.pool, ctx.tenantId, { taxonomy: body.categories });
      reply.send({ categories: cfg.taxonomy });
    } catch (e) { sendError(reply, e); }
  });

  // ── Suggest categories (MUST be before /:id) ──────────────────────────────

  app.post('/api/calls/suggest-categories', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      requireAdmin(ctx);
      const { llm, model } = await tenantLlm(app, ctx.tenantId);
      reply.send({ suggested: await suggestCategories({ pool: app.pool, tenantId: ctx.tenantId, llm, model }) });
    } catch (e) { sendError(reply, e); }
  });

  // ── Setup categories (MUST be before /:id) ────────────────────────────────

  app.post('/api/calls/setup-categories', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      requireAdmin(ctx);
      const body = z.object({
        categories: z.array(z.string().min(1)).max(30).optional(),
        replace: z.boolean().optional(),
      }).parse(req.body ?? {});
      const { llm, model } = await tenantLlm(app, ctx.tenantId);
      reply.send(await setupCategories({ pool: app.pool, tenantId: ctx.tenantId, llm, model, categories: body.categories, replace: body.replace }));
    } catch (e) { sendError(reply, e); }
  });

  // ── Retag (MUST be before /:id) ───────────────────────────────────────────

  app.post('/api/calls/retag', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      requireAdmin(ctx);
      const { llm, model } = await tenantLlm(app, ctx.tenantId);
      reply.send(await retagCalls({ pool: app.pool, tenantId: ctx.tenantId, llm, model }));
    } catch (e) { sendError(reply, e); }
  });

  // ── Import past sent emails as calls (MUST be before /:id) ────────────────

  app.post('/api/calls/import-past', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      requireAdmin(ctx);
      const { llm, model } = await tenantLlm(app, ctx.tenantId);
      reply.send(await backfillCallsFromEmails({ pool: app.pool, tenantId: ctx.tenantId, llm, model }));
    } catch (e) { sendError(reply, e); }
  });

  // ── Call-line settings (MUST be before /:id) ─────────────────────────────

  app.get('/api/calls/settings', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      requireAdmin(ctx);
      const cfg = await getLineReportConfig(app.pool, ctx.tenantId);
      reply.send({ ingestSendsAsCalls: cfg?.ingest_sends_as_calls ?? false });
    } catch (e) { sendError(reply, e); }
  });

  app.put('/api/calls/settings', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      requireAdmin(ctx);
      const body = z.object({ ingestSendsAsCalls: z.boolean() }).parse(req.body);
      const cfg = await upsertLineReportConfig(app.pool, ctx.tenantId, { ingestSendsAsCalls: body.ingestSendsAsCalls });
      reply.send({ ingestSendsAsCalls: cfg.ingest_sends_as_calls });
    } catch (e) { sendError(reply, e); }
  });

  // ── Get single call (parameterised — after literal paths) ─────────────────

  app.get('/api/calls/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      requireAdmin(ctx);
      const call = await getCall(app.pool, ctx.tenantId, (req.params as { id: string }).id);
      if (!call) throw new AppError('not_found', 404, 'Call not found');
      reply.send({ call });
    } catch (e) { sendError(reply, e); }
  });
}
