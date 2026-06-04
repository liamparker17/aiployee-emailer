import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { AppError, sendError } from '../util/errors.js';
import { listCalls, getCall, breakdownByCategory, callsPerDay } from '../repos/callAnalytics.js';
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

  app.get('/api/calls', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      requireAdmin(ctx);
      const q = req.query as Record<string, string>;
      const out = await listCalls(app.pool, ctx.tenantId, {
        category: q.category || undefined,
        search: q.search || undefined,
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
        offset: q.offset ? Number(q.offset) : undefined,
      });
      reply.send(out);
    } catch (e) { sendError(reply, e); }
  });

  // ── Breakdown (MUST be before /:id) ────────────────────────────────────────

  app.get('/api/calls/breakdown', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      requireAdmin(ctx);
      const w = (req.query as Record<string, string>).window ?? '7d';
      const { start, end } = windowRange(w);
      const [byCategory, perDay] = await Promise.all([
        breakdownByCategory(app.pool, ctx.tenantId, start, end),
        callsPerDay(app.pool, ctx.tenantId, start, end),
      ]);
      const total = byCategory.reduce((s, b) => s + b.count, 0);
      reply.send({ window: w, total, byCategory, perDay });
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
