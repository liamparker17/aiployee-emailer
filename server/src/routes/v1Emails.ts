import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sendError, AppError } from '../util/errors.js';
import { queueEmail, SendInputShape } from '../send/pipeline.js';
import { getEmail, listEmails, type EmailStatus } from '../repos/emails.js';
import { getBoss } from '../boss.js';
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
      const body = ApiSendBody.parse(req.body);
      const email = await queueEmail({
        pool: app.pool,
        enqueueSend: async (id) => { await getBoss().send('send-email', { emailId: id }); },
        input: { ...body, tenantId: ctx.tenantId, apiKeyId: ctx.apiKeyId },
      });
      reply.code(202).send({ id: email.id, status: email.status, scheduled_for: email.scheduled_for });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/v1/emails/:id', async (req, reply) => {
    try {
      const ctx = requireCtx(req);
      const { id } = req.params as { id: string };
      const e = await getEmail(app.pool, ctx.tenantId, id);
      if (!e) throw new AppError('not_found', 404, 'Email not found');
      reply.send({ email: e });
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
      reply.send({ emails: list });
    } catch (e) { sendError(reply, e); }
  });
}
