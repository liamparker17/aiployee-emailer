import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireCtx, requireSuperAdmin } from '@aiployee/core';
import { AppError, sendError } from '@aiployee/core';
import { listTenants, getTenant } from '../repos/tenants.js';

const Body = z.object({ tenantId: z.string().uuid() });

export async function registerSessionRoutes(app: FastifyInstance) {
  // Tenants the signed-in user can access: super-admins see all; everyone else sees
  // their own tenant. (The tenant picker/switcher use this — NOT the super-admin-only
  // /api/admin/tenants, which 403s for tenant members and left them with no access.)
  app.get('/api/session/tenants', async (req, reply) => {
    try {
      const ctx = requireCtx(req);
      if (ctx.role === 'super_admin') return reply.send({ tenants: await listTenants(app.pool) });
      const t = ctx.tenantId ? await getTenant(app.pool, ctx.tenantId) : null;
      return reply.send({ tenants: t ? [t] : [] });
    } catch (e) { return sendError(reply, e); }
  });

  app.post('/api/session/active-tenant', async (req, reply) => {
    try {
      const ctx = requireCtx(req);
      const { tenantId } = Body.parse(req.body);
      // Tenant members have a fixed tenant — they may only "activate" their own (a no-op
      // on the session, since ctx.tenantId already drives scoping). This lets the picker/gate
      // call setActiveTenant uniformly without 403ing non-super-admins out of their portal.
      if (ctx.role !== 'super_admin') {
        if (tenantId !== ctx.tenantId) throw new AppError('forbidden', 403, 'Cannot switch tenants');
        return reply.send({ ok: true, tenantId });
      }
      const r = await app.pool.query('SELECT 1 FROM tenants WHERE id = $1', [tenantId]);
      if (r.rowCount === 0) throw new AppError('not_found', 404, 'Tenant not found');
      req.session.activeTenantId = tenantId;
      await req.session.save();
      return reply.send({ ok: true, tenantId });
    } catch (e) { return sendError(reply, e); }
  });

  app.get('/api/session/active-tenant', async (req, reply) => {
    try {
      const ctx = requireCtx(req);
      if (ctx.role !== 'super_admin') return reply.send({ tenantId: ctx.tenantId || null });
      return reply.send({ tenantId: req.session.activeTenantId ?? null });
    } catch (e) { return sendError(reply, e); }
  });

  app.delete('/api/session/active-tenant', async (req, reply) => {
    try {
      requireSuperAdmin(req);
      req.session.activeTenantId = undefined;
      await req.session.save();
      return reply.send({ ok: true });
    } catch (e) { return sendError(reply, e); }
  });
}
