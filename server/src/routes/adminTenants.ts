import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSuperAdmin } from '@aiployee/core';
import { sendError, AppError } from '@aiployee/core';
import { createTenant, listTenants, deleteTenant, renameTenant } from '../repos/tenants.js';
import { createInvitedUser } from '../repos/users.js';

const CreateBody = z.object({
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  adminEmail: z.string().email(),
});

export async function registerAdminTenantRoutes(app: FastifyInstance) {
  app.get('/api/admin/tenants', async (req, reply) => {
    try { requireSuperAdmin(req); reply.send({ tenants: await listTenants(app.pool) }); }
    catch (e) { sendError(reply, e); }
  });

  app.post('/api/admin/tenants', async (req, reply) => {
    try {
      requireSuperAdmin(req);
      const body = CreateBody.parse(req.body);
      const tenant = await createTenant(app.pool, { name: body.name, slug: body.slug });
      const invite = await createInvitedUser(app.pool, {
        tenantId: tenant.id, email: body.adminEmail, role: 'tenant_admin',
      });
      return reply.code(201).send({
        tenant,
        invite: {
          token: invite.inviteToken,
          url: `${app.cfg.publicBaseUrl}/accept-invite?token=${invite.inviteToken}`,
        },
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return sendError(reply, new AppError('slug_taken', 409, 'Slug already in use'));
      sendError(reply, e);
    }
  });

  app.patch('/api/admin/tenants/:id', async (req, reply) => {
    try {
      requireSuperAdmin(req);
      const { id } = req.params as { id: string };
      const body = z.object({ name: z.string().min(1) }).parse(req.body);
      const tenant = await renameTenant(app.pool, id, body.name);
      if (!tenant) throw new AppError('not_found', 404, 'Tenant not found');
      return reply.send({ tenant });
    } catch (e) { sendError(reply, e); }
  });

  app.delete('/api/admin/tenants/:id', async (req, reply) => {
    try {
      requireSuperAdmin(req);
      const { id } = req.params as { id: string };
      const ok = await deleteTenant(app.pool, id);
      if (!ok) throw new AppError('not_found', 404, 'Tenant not found');
      return reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });
}
