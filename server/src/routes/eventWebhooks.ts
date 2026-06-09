import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '@aiployee/core';
import { sendError, AppError } from '@aiployee/core';
import {
  listEventWebhooks,
  createEventWebhook,
  deleteEventWebhook,
} from '@aiployee/core';

const ALLOWED_EVENTS = ['sent', 'delivered', 'bounced', 'complained'] as const;

const CreateSchema = z.object({
  url: z.string().url(),
  secret: z.string().min(1),
  events: z.array(z.enum(ALLOWED_EVENTS)).min(1),
});

export async function registerEventWebhookRoutes(app: FastifyInstance) {
  app.get('/api/event-webhooks', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const webhooks = await listEventWebhooks(app.pool, ctx.tenantId);
      return reply.send({ webhooks });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/event-webhooks', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const body = CreateSchema.parse(req.body);
      const webhook = await createEventWebhook(app.pool, app.cfg.encKey, {
        tenantId: ctx.tenantId,
        url: body.url,
        events: body.events,
        secret: body.secret,
      });
      return reply.code(201).send({ webhook });
    } catch (e) { sendError(reply, e); }
  });

  app.delete('/api/event-webhooks/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const deleted = await deleteEventWebhook(app.pool, ctx.tenantId, id);
      if (!deleted) throw new AppError('not_found', 404, 'Webhook not found');
      return reply.code(204).send();
    } catch (e) { sendError(reply, e); }
  });
}
