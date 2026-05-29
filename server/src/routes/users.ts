import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { sendError, AppError } from '../util/errors.js';
import { listUsersForTenant, createInvitedUser, getUserById, countTenantAdmins, deleteUser } from '../repos/users.js';

const InviteBody = z.object({ email: z.string().email(), role: z.enum(['tenant_admin','tenant_user']).default('tenant_user') });

export async function registerUserRoutes(app: FastifyInstance) {
  app.get('/api/users', async (req, reply) => {
    try { const ctx = requireTenantCtx(req); reply.send({ users: await listUsersForTenant(app.pool, ctx.tenantId) }); }
    catch (e) { sendError(reply, e); }
  });
  app.post('/api/users/invite', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const body = InviteBody.parse(req.body);
      const r = await createInvitedUser(app.pool, { tenantId: ctx.tenantId, email: body.email, role: body.role });
      return reply.code(201).send({
        user: r.user,
        invite: { token: r.inviteToken, url: `${app.cfg.publicBaseUrl}/accept-invite?token=${r.inviteToken}` },
      });
    } catch (e) { sendError(reply, e); }
  });
  app.delete('/api/users/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') {
        throw new AppError('forbidden', 403, 'Admin role required to delete users');
      }
      const { id } = req.params as { id: string };
      if (id === ctx.userId) throw new AppError('cannot_delete_self', 400, 'You cannot delete your own account');
      const target = await getUserById(app.pool, id);
      if (!target || target.tenant_id !== ctx.tenantId) throw new AppError('not_found', 404, 'User not found');
      if (target.role === 'tenant_admin' && (await countTenantAdmins(app.pool, ctx.tenantId)) <= 1) {
        throw new AppError('last_admin', 400, 'Cannot delete the last tenant admin');
      }
      const ok = await deleteUser(app.pool, id);
      if (!ok) throw new AppError('not_found', 404, 'User not found');
      return reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });
}
