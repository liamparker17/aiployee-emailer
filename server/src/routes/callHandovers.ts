import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { AppError, sendError } from '../util/errors.js';
import { listHandovers, getHandover, setHandoverStatus, type HandoverStatus } from '../repos/callHandovers.js';
import { forwardHandover } from '../agent/abe/handoverSend.js';

function requireAdmin(ctx: ReturnType<typeof requireTenantCtx>): void {
  if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') {
    throw new AppError('forbidden', 403, 'Admin role required');
  }
}

const PatchBody = z.object({
  caller_name: z.string().max(200).nullable().optional(),
  caller_phone: z.string().max(50).nullable().optional(),
  account_ref: z.string().max(100).nullable().optional(),
  recommended_action: z.string().max(2000).optional(),
  urgency: z.enum(['low', 'med', 'high']).optional(),
});

export function registerCallHandoverRoutes(app: FastifyInstance): void {
  app.get('/api/agent/handovers', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      requireAdmin(ctx);
      const status = (req.query as any)?.status as HandoverStatus | undefined;
      reply.send({ handovers: await listHandovers(app.pool, ctx.tenantId, status) });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/agent/handovers/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      requireAdmin(ctx);
      const h = await getHandover(app.pool, ctx.tenantId, (req.params as any).id);
      if (!h) throw new AppError('not_found', 404, 'Handover not found');
      reply.send({ handover: h });
    } catch (e) { sendError(reply, e); }
  });

  app.patch('/api/agent/handovers/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      requireAdmin(ctx);
      const id = (req.params as any).id;
      const b = PatchBody.parse(req.body);
      const h = await getHandover(app.pool, ctx.tenantId, id);
      if (!h) throw new AppError('not_found', 404, 'Handover not found');
      if (h.status !== 'pending') throw new AppError('conflict', 409, 'Only pending handovers can be edited');
      const name = b.caller_name !== undefined ? b.caller_name : h.caller_name;
      const phone = b.caller_phone !== undefined ? b.caller_phone : h.caller_phone;
      const missing = ['caller_name', 'caller_phone', 'reason_category'].filter(f =>
        f === 'caller_name' ? !name : f === 'caller_phone' ? !phone : !h.reason_category);
      const r = await app.pool.query(
        `UPDATE call_handovers SET caller_name=$3, caller_phone=$4,
           account_ref=COALESCE($5,account_ref), recommended_action=COALESCE($6,recommended_action),
           urgency=COALESCE($7,urgency), missing_fields=$8
         WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [ctx.tenantId, id, name, phone, b.account_ref ?? null, b.recommended_action ?? null, b.urgency ?? null, JSON.stringify(missing)]);
      reply.send({ handover: r.rows[0] });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/agent/handovers/:id/forward', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      requireAdmin(ctx);
      const out = await forwardHandover({
        pool: app.pool,
        encKey: app.cfg.encKey,
        baseUrl: app.cfg.publicBaseUrl,
        tenantId: ctx.tenantId,
        handoverId: (req.params as any).id,
        approvedBy: ctx.userId ?? 'unknown',
      });
      if (!out.ok) throw new AppError('cannot_forward', 400, out.reason);
      reply.send({ handover: out.handover });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/agent/handovers/:id/dismiss', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      requireAdmin(ctx);
      const reason = (req.body as any)?.reason ?? null;
      const h = await setHandoverStatus(app.pool, ctx.tenantId, (req.params as any).id, 'dismissed', { dismissReason: reason });
      if (!h) throw new AppError('not_found', 404, 'Handover not found');
      reply.send({ handover: h });
    } catch (e) { sendError(reply, e); }
  });
}
