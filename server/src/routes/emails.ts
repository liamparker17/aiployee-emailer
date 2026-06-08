import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '@aiployee/core';
import { sendError, AppError } from '@aiployee/core';
import { getEmail, listEmails, cancelScheduledEmail, type EmailStatus } from '../repos/emails.js';

export async function registerEmailRoutes(app: FastifyInstance) {
  app.get('/api/emails', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
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
  app.get('/api/emails/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const e = await getEmail(app.pool, ctx.tenantId, id);
      if (!e) throw new AppError('not_found', 404, 'Email not found');
      return reply.send({ email: e });
    } catch (e) { sendError(reply, e); }
  });
  app.post('/api/emails/:id/cancel', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const ok = await cancelScheduledEmail(app.pool, ctx.tenantId, id);
      if (!ok) throw new AppError('not_cancelable', 400, 'Only a scheduled (queued) email can be canceled');
      return reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });
}
