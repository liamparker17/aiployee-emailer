import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sendError, AppError } from '../util/errors.js';
import { queueEmail, SendInputShape } from '../send/pipeline.js';
import { getEmail, listEmails, claimForSend, type EmailStatus } from '../repos/emails.js';
import { dispatchEmail } from '../send/dispatch.js';
import { requireCtx } from '../auth/ctx.js';

const ApiSendBody = SendInputShape.omit({ tenantId: true, apiKeyId: true }).refine(
  (v) => (v.subject && v.html) || v.template,
  { message: 'Provide either subject+html or template' },
);

export async function registerV1EmailRoutes(app: FastifyInstance) {
  app.post('/v1/emails', async (req, reply) => {
    try {
      const ctx = requireCtx(req);
      if (ctx.role !== 'api_key') throw new AppError('unauthorized', 401, 'API key required');
      // TEMP DIAGNOSTIC LOG — remove once Jobix wiring confirmed.
      // Logs the keys + value lengths of the variables Jobix sends, no PII content.
      try {
        const rawBody = req.body as { template?: string; variables?: Record<string, unknown> };
        const varSummary = rawBody?.variables
          ? Object.fromEntries(Object.entries(rawBody.variables).map(([k, v]) => [k, {
              type: typeof v,
              length: typeof v === 'string' ? v.length : null,
              empty: v === '' || v == null,
              preview: typeof v === 'string' ? v.slice(0, 80) : v,
            }]))
          : null;
        req.log.info({ template: rawBody?.template, variables: varSummary }, 'v1_emails_diagnostic');
      } catch {}
      const body = ApiSendBody.parse(req.body);

      // Insert; pipeline does NOT trigger the worker — we drive that ourselves below.
      const email = await queueEmail({
        pool: app.pool,
        enqueueSend: async () => {},
        input: { ...body, tenantId: ctx.tenantId, apiKeyId: ctx.apiKeyId },
      });

      // For immediate (no scheduled_for) sends, dispatch inline so the API caller gets a real status.
      // Scheduled sends + suppressed get returned as-is; the cron picks scheduled ones up later.
      const isImmediate = !body.scheduled_for && email.status === 'queued';
      if (isImmediate) {
        // Claim THIS specific row by id (not any due row) so we never strand another tenant's
        // queued email in 'sending' state waiting for the stuck-row cron to requeue it.
        const ours = await claimForSend(app.pool, email.id);
        if (ours) {
          const result = await dispatchEmail({ pool: app.pool, encKey: app.cfg.encKey, email: ours });
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
