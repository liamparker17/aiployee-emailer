import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { sendError, AppError } from '../util/errors.js';
import { claimDueForSend, requeueFailed } from '../repos/emails.js';
import { dispatchEmail } from '../send/dispatch.js';

function requireCronAuth(req: FastifyRequest, secret: string): void {
  const auth = req.headers.authorization ?? '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7).trim() : (req.headers['x-cron-secret'] as string | undefined) ?? '';
  if (!provided || provided !== secret) {
    throw new AppError('unauthorized', 401, 'Invalid cron secret');
  }
}

export async function registerCronRoutes(app: FastifyInstance) {
  // POST /v1/cron/process-queue — invoked every ~1min by cron-job.org
  app.post('/v1/cron/process-queue', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      requireCronAuth(req, app.cfg.cronSecret);
      const claimed = await claimDueForSend(app.pool, 50);
      const results = await Promise.all(claimed.map(email =>
        dispatchEmail({ pool: app.pool, encKey: app.cfg.encKey, email }),
      ));
      const sent = results.filter(r => r.ok).length;
      const failed = results.length - sent;
      reply.send({ ok: true, claimed: claimed.length, sent, failed });
    } catch (e) { sendError(reply, e); }
  });

  // POST /v1/cron/retry-failed — invoked every ~5min by cron-job.org
  app.post('/v1/cron/retry-failed', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      requireCronAuth(req, app.cfg.cronSecret);
      const requeued = await requeueFailed(app.pool, { maxRetries: 5, cooloffSeconds: 300 });
      reply.send({ ok: true, requeued });
    } catch (e) { sendError(reply, e); }
  });
}
