import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sendError, AppError } from '@aiployee/core';
import { queueEmail, SendInputShape } from '@aiployee/core';
import { getEmail, listEmails, claimForSend, type EmailStatus } from '@aiployee/core';
import { dispatchEmail } from '@aiployee/core';
import { requireCtx } from '@aiployee/core';
import { captureCallFromSend } from '../agent/abe/mirrorCall.js';

const ApiSendBody = SendInputShape.omit({ tenantId: true, apiKeyId: true }).refine(
  (v) => (v.subject && v.html) || v.template,
  { message: 'Provide either subject+html or template' },
);

export async function registerV1EmailRoutes(app: FastifyInstance) {
  app.post('/v1/emails', async (req, reply) => {
    try {
      const ctx = requireCtx(req);
      if (ctx.role !== 'api_key') throw new AppError('unauthorized', 401, 'API key required');
      const body = ApiSendBody.parse(req.body);

      // Insert; pipeline does NOT trigger the worker — we drive that ourselves below.
      const email = await queueEmail({
        pool: app.pool,
        enqueueSend: async () => {},
        input: { ...body, tenantId: ctx.tenantId, apiKeyId: ctx.apiKeyId },
      });

      // Mirror Jobix call summaries into Abe's call pipeline (opt-in per tenant). Best-effort:
      // a mirror failure must NEVER fail the real send. Runs exactly once per created email.
      try {
        const b = body as { variables?: Record<string, unknown>; text?: string; html?: string; subject?: string };
        await captureCallFromSend({
          pool: app.pool, tenantId: ctx.tenantId, emailId: email.id,
          summaryVar: b.variables?.summary, text: b.text ?? null, html: b.html ?? null, subject: b.subject ?? null,
        });
      } catch (err) { req.log?.error?.({ err }, 'mirror call from send failed'); }

      // For immediate (no scheduled_for) sends, dispatch inline so the API caller gets a real status.
      // Scheduled sends + suppressed get returned as-is; the cron picks scheduled ones up later.
      const isImmediate = !body.scheduled_for && email.status === 'queued';
      if (isImmediate) {
        // Claim THIS specific row by id (not any due row) so we never strand another tenant's
        // queued email in 'sending' state waiting for the stuck-row cron to requeue it.
        const ours = await claimForSend(app.pool, email.id);
        if (ours) {
          const result = await dispatchEmail({ pool: app.pool, encKey: app.cfg.encKey, email: ours, baseUrl: app.cfg.publicBaseUrl });
          if (result.ok) {
            return reply.code(202).send({ id: email.id, status: 'sent', message_id: result.messageId, error: null });
          }
          return reply.code(202).send({ id: email.id, status: 'failed', message_id: null, error: result.error });
        }
        // Race: cron worker already grabbed it. Return queued.
      }

      return reply.code(202).send({ id: email.id, status: email.status, scheduled_for: email.scheduled_for });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/v1/emails/:id', async (req, reply) => {
    try {
      const ctx = requireCtx(req);
      const { id } = req.params as { id: string };
      const e = await getEmail(app.pool, ctx.tenantId, id);
      if (!e) throw new AppError('not_found', 404, 'Email not found');
      return reply.send({ email: e });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/v1/emails', async (req, reply) => {
    try {
      const ctx = requireCtx(req);
      const q = z.object({
        status: z.string().optional(),
        since: z.coerce.date().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }).parse(req.query);
      const list = await listEmails(app.pool, ctx.tenantId, {
        status: q.status as EmailStatus | undefined, since: q.since, limit: q.limit,
      });
      return reply.send({ emails: list });
    } catch (e) { sendError(reply, e); }
  });
}
