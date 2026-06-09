import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { AppError, sendError } from '../util/errors.js';
import { createAgent, listAgents, updateAgent } from '../repos/callAgents.js';

function requireAdmin(ctx: ReturnType<typeof requireTenantCtx>): void {
  if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') {
    throw new AppError('forbidden', 403, 'Admin role required');
  }
}

const valuesSchema = z.array(z.object({ key: z.string().min(1), label: z.string().min(1), required: z.boolean(), type: z.string().optional() })).max(50);

export function registerCallAgentRoutes(app: FastifyInstance): void {
  app.post('/api/calls/agents', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const b = z.object({
        label: z.string().min(1).max(120),
        company_key: z.string().min(1).max(500),
        values_schema: valuesSchema.default([]),
        default_timezone: z.string().max(60).optional(),
      }).parse(req.body);
      const agent = await createAgent(app.pool, app.cfg.encKey, {
        tenantId: ctx.tenantId, label: b.label, companyKey: b.company_key,
        valuesSchema: b.values_schema, defaultTimezone: b.default_timezone, createdBy: ctx.userId,
      });
      reply.code(201).send({ agent });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/calls/agents', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      reply.send({ agents: await listAgents(app.pool, ctx.tenantId) });
    } catch (e) { sendError(reply, e); }
  });

  app.patch('/api/calls/agents/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const id = (req.params as { id: string }).id;
      const b = z.object({
        label: z.string().min(1).max(120).optional(),
        company_key: z.string().min(1).max(500).optional(),
        values_schema: valuesSchema.optional(),
        default_timezone: z.string().max(60).optional(),
        active: z.boolean().optional(),
      }).parse(req.body);
      const agent = await updateAgent(app.pool, app.cfg.encKey, ctx.tenantId, id, {
        label: b.label, companyKey: b.company_key, valuesSchema: b.values_schema,
        defaultTimezone: b.default_timezone, active: b.active,
      });
      if (!agent) throw new AppError('not_found', 404, 'Agent not found');
      reply.send({ agent });
    } catch (e) { sendError(reply, e); }
  });
}
