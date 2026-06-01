import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { sendError, AppError } from '../util/errors.js';
import { claimDueForSend, requeueFailedAndStuck } from '../repos/emails.js';
import { dispatchBatch } from '../send/dispatch.js';
import { listEnabledGoals } from '../repos/agentGoals.js';
import { runAbeShift } from '../agent/abe/shift.js';

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
      const goals = await listEnabledGoals(app.pool);
      let proposed = 0;
      const skipped: Array<{ tenantId: string; reason: string }> = [];
      for (const g of goals) {
        try {
          const r = await runAbeShift({
            pool: app.pool, encKey: app.cfg.encKey, tenantId: g.tenant_id,
            llmFactory: app.agentLlmFactory!,
          });
          if (r.status === 'proposed') proposed += 1;
          else skipped.push({ tenantId: g.tenant_id, reason: r.reason });
        } catch (err) {
          skipped.push({ tenantId: g.tenant_id, reason: (err as Error).message });
        }
      }
      return reply.send({ ok: true, goals: goals.length, proposed, skipped });
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
}
