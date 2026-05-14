import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { sendError, AppError } from '../util/errors.js';
import { addSuppression, listSuppressions, removeSuppression } from '../repos/suppressions.js';

const AddBody = z.object({ address: z.string().email(), reason: z.enum(['bounce','complaint','manual']).default('manual') });

export async function registerSuppressionRoutes(app: FastifyInstance) {
  app.get('/api/suppressions', async (req, reply) => {
    try { const ctx = requireTenantCtx(req); reply.send({ suppressions: await listSuppressions(app.pool, ctx.tenantId) }); }
    catch (e) { sendError(reply, e); }
  });
  app.post('/api/suppressions', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const body = AddBody.parse(req.body);
      await addSuppression(app.pool, { tenantId: ctx.tenantId, ...body });
      reply.code(201).send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });
  app.delete('/api/suppressions/:address', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { address } = req.params as { address: string };
      const ok = await removeSuppression(app.pool, ctx.tenantId, decodeURIComponent(address));
      if (!ok) throw new AppError('not_found', 404, 'Suppression not found');
      reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });
}
