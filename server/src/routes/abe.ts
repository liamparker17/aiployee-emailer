import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { AppError, sendError } from '../util/errors.js';
import { getGoal, upsertGoal } from '../repos/agentGoals.js';
import { listPlays, getPlay } from '../repos/agentPlays.js';
import { startPlayExecution } from '../agent/abe/execute.js';

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

  app.post('/api/agent/plays/:id/approve', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') throw new AppError('forbidden', 403, 'Admin role required');
      const { id } = req.params as { id: string };
      const play = await getPlay(app.pool, ctx.tenantId, id);
      if (!play) throw new AppError('not_found', 404, 'Play not found');
      if (play.status !== 'proposed' && play.status !== 'pending_approval') {
        throw new AppError('conflict', 409, `Play not approvable (status ${play.status})`);
      }
      const { queued } = await startPlayExecution({ pool: app.pool, encKey: app.cfg.encKey, baseUrl: app.cfg.publicBaseUrl, play });
      const updated = await getPlay(app.pool, ctx.tenantId, id);
      return reply.send({ play: updated, queued });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/agent/plays/:id/reject', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') throw new AppError('forbidden', 403, 'Admin role required');
      const { id } = req.params as { id: string };
      const { reason } = (req.body ?? {}) as { reason?: string };
      const play = await getPlay(app.pool, ctx.tenantId, id);
      if (!play) throw new AppError('not_found', 404, 'Play not found');
      const upd = await app.pool.query(
        `UPDATE agent_plays SET status = 'rejected', rejection_reason = $3, updated_at = now()
           WHERE tenant_id = $1 AND id = $2 RETURNING *`, [ctx.tenantId, id, reason ?? null]);
      return reply.send({ play: upd.rows[0] });
    } catch (e) { sendError(reply, e); }
  });
}
