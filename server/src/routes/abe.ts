import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { AppError, sendError } from '../util/errors.js';
import { getGoal, upsertGoal } from '../repos/agentGoals.js';
import { listPlays, getPlay } from '../repos/agentPlays.js';

const GoalBody = z.object({
  enabled: z.boolean().optional(),
  dormantWindowDays: z.number().int().min(1).max(3650).optional(),
  autoFireMaxAudience: z.number().int().min(0).optional(),
  maxTouches: z.number().int().min(1).max(5).optional(),
  touchSpacingDays: z.number().int().min(1).max(60).optional(),
  lineManagerEmail: z.string().email().nullable().optional(),
  brandVoice: z.string().max(2000).nullable().optional(),
});

export function registerAbeRoutes(app: FastifyInstance): void {
  app.get('/api/agent/goals', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const goal = await getGoal(app.pool, ctx.tenantId);
      return reply.send({ goal });
    } catch (e) { sendError(reply, e); }
  });

  app.put('/api/agent/goals', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') {
        throw new AppError('forbidden', 403, 'Admin role required');
      }
      const body = GoalBody.parse(req.body);
      const goal = await upsertGoal(app.pool, ctx.tenantId, body);
      return reply.send({ goal });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/agent/plays', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const plays = await listPlays(app.pool, ctx.tenantId);
      return reply.send({ plays });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/agent/plays/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const play = await getPlay(app.pool, ctx.tenantId, id);
      if (!play) throw new AppError('not_found', 404, 'Play not found');
      return reply.send({ play });
    } catch (e) { sendError(reply, e); }
  });
}
