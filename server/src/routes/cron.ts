import type { FastifyInstance, FastifyRequest, FastifyReply, RouteHandlerMethod } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { sendError, AppError } from '../util/errors.js';
import { claimDueForSend, requeueFailedAndStuck } from '../repos/emails.js';
import { dispatchBatch } from '../send/dispatch.js';
import { listEnabledGoals, getGoal } from '../repos/agentGoals.js';
import { runAbeShift } from '../agent/abe/shift.js';
import { runLineReportShift } from '../agent/abe/lineShift.js';
import { extractHandovers } from '../agent/abe/handoverExtract.js';
import { openAiFactory } from '../agent/runner.js';
import { listEnabledLineConfigs } from '../repos/lineReportConfigs.js';
import { getAgentOpenAIKey } from '../repos/agent.js';
import { CALL_BATCH_MODEL } from '../agent/abe/models.js';
import { listExecutingPlays, listPlaysForOutcomeRollup } from '../repos/agentPlays.js';
import { getDefaultSender } from '../repos/senders.js';
import { advancePlayTouches } from '../agent/abe/touches.js';
import { updatePlayOutcomes } from '../repos/agentOutcomes.js';
import { runCallQueue } from '../calls/runCallQueue.js';
import { runFlowQueue } from '../flows/runFlowQueue.js';

const CALL_QUEUE_BATCH = 50; // outbound launches per cron tick (conservative; Jobix dials async)

function requireCronAuth(req: FastifyRequest, secret: string): void {
  const auth = req.headers.authorization ?? '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7).trim() : (req.headers['x-cron-secret'] as string | undefined) ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (!provided || a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AppError('unauthorized', 401, 'Invalid cron secret');
  }
}

export async function registerCronRoutes(app: FastifyInstance) {
  // Cron endpoints accept BOTH GET and POST: Vercel-native crons (vercel.json `crons`) invoke
  // them with GET (auth via `Authorization: Bearer $CRON_SECRET`), while external schedulers /
  // tests use POST with the same secret. requireCronAuth accepts Bearer or X-Cron-Secret.
  const cron = (url: string, handler: RouteHandlerMethod) =>
    app.route({ method: ['GET', 'POST'], url, handler });

  // /v1/cron/process-queue — dispatch due/queued emails (incl. Abe's touch sends). ~every minute.
  cron('/v1/cron/process-queue', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      requireCronAuth(req, app.cfg.cronSecret);
      const claimed = await claimDueForSend(app.pool, app.cfg.cronBatchSize);
      const results = await dispatchBatch({ pool: app.pool, encKey: app.cfg.encKey, emails: claimed, baseUrl: app.cfg.publicBaseUrl });
      const sent = results.filter(r => r.ok).length;
      const failed = results.length - sent;
      return reply.send({ ok: true, claimed: claimed.length, sent, failed });
    } catch (e) { sendError(reply, e); }
  });

  // /v1/cron/abe-shift — daily: run Abe's shift for all enabled goals.
  cron('/v1/cron/abe-shift', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      requireCronAuth(req, app.cfg.cronSecret);
      const llmFactory = app.agentLlmFactory ?? openAiFactory;
      const goals = await listEnabledGoals(app.pool);
      let executed = 0;
      let pendingApproval = 0;
      const skipped: Array<{ tenantId: string; reason: string }> = [];
      // Sequential: one LLM call per enabled tenant. Revisit (queue/concurrency) if tenant count grows large.
      for (const g of goals) {
        try {
          const r = await runAbeShift({
            pool: app.pool, encKey: app.cfg.encKey, tenantId: g.tenant_id,
            baseUrl: app.cfg.publicBaseUrl,
            llmFactory,
          });
          if (r.status === 'executed') executed += 1;
          else if (r.status === 'pending_approval') pendingApproval += 1;
          else skipped.push({ tenantId: g.tenant_id, reason: r.reason });
        } catch (err) {
          skipped.push({ tenantId: g.tenant_id, reason: err instanceof Error ? err.message : String(err) });
        }
      }
      return reply.send({ ok: true, goals: goals.length, executed, pendingApproval, skipped });
    } catch (e) { sendError(reply, e); }
  });

  // /v1/cron/retry-failed — requeues failed rows (under retry cap, after cool-off) AND stuck-sending
  // rows. Default: 1 retry total = 2 attempts. ~every few minutes.
  cron('/v1/cron/retry-failed', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      requireCronAuth(req, app.cfg.cronSecret);
      const out = await requeueFailedAndStuck(app.pool, {
        maxAttempts: 2,        // initial + 1 retry
        cooloffSeconds: 60,
        stuckSeconds: 120,
      });
      return reply.send({ ok: true, ...out });
    } catch (e) { sendError(reply, e); }
  });

  // /v1/cron/abe-touches — daily: advance each executing play through its next due touch.
  cron('/v1/cron/abe-touches', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      requireCronAuth(req, app.cfg.cronSecret);
      const plays = await listExecutingPlays(app.pool);
      let touchesQueued = 0, done = 0;
      const skipped: Array<{ playId: string; reason: string }> = [];
      for (const p of plays) {
        try {
          const goal = await getGoal(app.pool, p.tenant_id);
          const sender = await getDefaultSender(app.pool, p.tenant_id);
          if (!goal || !sender) { skipped.push({ playId: p.id, reason: !goal ? 'no_goal' : 'no_sender' }); continue; }
          const r = await advancePlayTouches({
            pool: app.pool, encKey: app.cfg.encKey, baseUrl: app.cfg.publicBaseUrl,
            play: p, touchSpacingDays: goal.touch_spacing_days, sender,
          });
          touchesQueued += r.queued;
          if (r.done) done += 1;
        } catch (err) { skipped.push({ playId: p.id, reason: err instanceof Error ? err.message : String(err) }); }
      }
      return reply.send({ ok: true, plays: plays.length, touchesQueued, done, skipped });
    } catch (e) { sendError(reply, e); }
  });

  // /v1/cron/line-report — daily: run the line-report shift for every enabled tenant config.
  cron('/v1/cron/line-report', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      requireCronAuth(req, app.cfg.cronSecret);
      // openAiFactory yields the full LlmClient; the line-report shift only needs the
      // minimal LlmLike (chat -> { content }). The nominal mismatch is safe at runtime.
      const factory = (app.agentLlmFactory ?? openAiFactory) as unknown as
        Parameters<typeof runLineReportShift>[0]['llmFactory'];
      const configs = await listEnabledLineConfigs(app.pool);
      let ran = 0;
      const skipped: Array<{ tenantId: string; reason: string }> = [];
      for (const c of configs) {
        try {
          const key = await getAgentOpenAIKey(app.pool, app.cfg.encKey, c.tenant_id);
          if (!key && !app.agentLlmFactory) {
            skipped.push({ tenantId: c.tenant_id, reason: 'no_openai_key' });
            continue;
          }
          const r = await runLineReportShift({
            pool: app.pool, tenantId: c.tenant_id,
            llmFactory: factory,
            model: CALL_BATCH_MODEL, now: new Date(),
            openAiKey: key ?? undefined,
          });
          if (r.status === 'ran') ran++;
          else skipped.push({ tenantId: c.tenant_id, reason: r.reason });
        } catch (err) {
          skipped.push({ tenantId: c.tenant_id, reason: err instanceof Error ? err.message : String(err) });
        }
      }
      return reply.send({ ok: true, configs: configs.length, ran, skipped });
    } catch (e) { sendError(reply, e); }
  });

  // /v1/cron/abe-handovers — every 5 min: extract callback handovers for new inbound calls.
  cron('/v1/cron/abe-handovers', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      requireCronAuth(req, app.cfg.cronSecret);
      // Same LlmClient->LlmLike bridge the /v1/cron/line-report block uses.
      const factory = (app.agentLlmFactory ?? openAiFactory) as unknown as
        (key?: string) => { chat(a: { model: string; messages: Array<{ role: string; content: string }> }): Promise<{ content: string }> };
      const configs = await listEnabledLineConfigs(app.pool);
      let ran = 0;
      for (const c of configs) {
        try {
          const key = await getAgentOpenAIKey(app.pool, app.cfg.encKey, c.tenant_id);
          if (!key && !app.agentLlmFactory) continue;
          await extractHandovers({ pool: app.pool, tenantId: c.tenant_id, llm: factory(key ?? undefined), model: CALL_BATCH_MODEL, batch: 100 });
          ran++;
        } catch (err) { req.log?.error?.({ err }, 'handover extract failed'); }
      }
      return reply.send({ ok: true, configs: configs.length, ran });
    } catch (e) { sendError(reply, e); }
  });

  // /v1/cron/abe-outcomes — daily: roll up engagement (opens/clicks/reactivations) for
  // executing/done plays whose attribution window has not yet closed.
  cron('/v1/cron/abe-outcomes', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      requireCronAuth(req, app.cfg.cronSecret);
      const plays = await listPlaysForOutcomeRollup(app.pool);
      let updated = 0;
      const errors: Array<{ playId: string; error: string }> = [];
      for (const p of plays) {
        try {
          await updatePlayOutcomes(app.pool, p.id);
          updated += 1;
        } catch (err) {
          errors.push({ playId: p.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return reply.send({ ok: true, plays: plays.length, updated, errors });
    } catch (e) { sendError(reply, e); }
  });

  // /v1/cron/process-call-queue — drain outbound call queue (claims + launches via Jobix). ~every minute.
  cron('/v1/cron/process-call-queue', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      requireCronAuth(req, app.cfg.cronSecret);
      const summary = await runCallQueue(app.pool, app.cfg.encKey, { batchSize: CALL_QUEUE_BATCH, maxAttempts: 3 });
      return reply.send({ ok: true, ...summary });
    } catch (e) { sendError(reply, e); }
  });

  // /v1/cron/process-flows — advance flow enrollments through their steps. ~every minute.
  cron('/v1/cron/process-flows', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      requireCronAuth(req, app.cfg.cronSecret);
      const summary = await runFlowQueue(app.pool, app.cfg.encKey, { batchSize: 100, maxStepsPerTick: 50 });
      return reply.send({ ok: true, ...summary });
    } catch (e) { sendError(reply, e); }
  });
}
