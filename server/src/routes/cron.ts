import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { sendError, AppError } from '../util/errors.js';
import { claimDueForSend, requeueFailedAndStuck } from '../repos/emails.js';
import { dispatchBatch } from '../send/dispatch.js';
import { listEnabledGoals, getGoal } from '../repos/agentGoals.js';
import { runAbeShift } from '../agent/abe/shift.js';
import { openAiFactory } from '../agent/runner.js';
import { listExecutingPlays } from '../repos/agentPlays.js';
import { getDefaultSender } from '../repos/senders.js';
import { advancePlayTouches } from '../agent/abe/touches.js';

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
  // POST /v1/cron/process-queue — invoked every ~1min by cron-job.org
  app.post('/v1/cron/process-queue', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      requireCronAuth(req, app.cfg.cronSecret);
      const claimed = await claimDueForSend(app.pool, app.cfg.cronBatchSize);
      const results = await dispatchBatch({ pool: app.pool, encKey: app.cfg.encKey, emails: claimed, baseUrl: app.cfg.publicBaseUrl });
      const sent = results.filter(r => r.ok).length;
      const failed = results.length - sent;
      return reply.send({ ok: true, claimed: claimed.length, sent, failed });
    } catch (e) { sendError(reply, e); }
  });

  // POST /v1/cron/abe-shift — invoked daily to run Abe's shift for all enabled goals
  app.post('/v1/cron/abe-shift', async (req: FastifyRequest, reply: FastifyReply) => {
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

  // POST /v1/cron/retry-failed — invoked every ~1-2min by cron-job.org.
  // Requeues failed rows (under retry cap, after cool-off) AND stuck-sending rows
  // (function crashed before marking outcome). Default: 1 retry total = 2 attempts.
  app.post('/v1/cron/retry-failed', async (req: FastifyRequest, reply: FastifyReply) => {
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

  // POST /v1/cron/abe-touches — advances each executing play through its next due touch
  app.post('/v1/cron/abe-touches', async (req, reply) => {
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
}
