import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { sendError } from '../util/errors.js';
import { listUsersForTenant, createInvitedUser } from '../repos/users.js';

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
}
