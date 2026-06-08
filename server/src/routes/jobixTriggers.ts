import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { AppError, sendError } from '@aiployee/core';
import { createTrigger, listTriggers, updateTrigger, deleteTrigger, listFires } from '../repos/jobixTriggers.js';
import { fireTrigger } from '../jobix/fireTrigger.js';

function requireAdmin(ctx: ReturnType<typeof requireTenantCtx>): void {
  if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') {
    throw new AppError('forbidden', 403, 'Admin role required');
  }
}

const placement = z.enum(['bearer', 'header', 'query', 'body']);
const varsSchema = z.record(z.string()).default({});

export function registerJobixTriggerRoutes(app: FastifyInstance): void {
  app.post('/api/jobix-triggers', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const b = z.object({
        label: z.string().min(1).max(120),
        url: z.string().max(500).optional(),
        token: z.string().min(1).max(2000),
        token_placement: placement.default('bearer'),
        token_param: z.string().max(120).optional(),
        payload_template: z.string().min(1).max(20000),
      }).parse(req.body);
      const trig = await createTrigger(app.pool, app.cfg.encKey, {
        tenantId: ctx.tenantId, label: b.label, url: b.url, token: b.token,
        tokenPlacement: b.token_placement, tokenParam: b.token_param, payloadTemplate: b.payload_template, createdBy: ctx.userId,
      });
      reply.code(201).send({ trigger: trig });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/jobix-triggers', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      reply.send({ triggers: await listTriggers(app.pool, ctx.tenantId) });
    } catch (e) { sendError(reply, e); }
  });

  app.patch('/api/jobix-triggers/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const id = (req.params as { id: string }).id;
      const b = z.object({
        label: z.string().min(1).max(120).optional(),
        url: z.string().max(500).optional(),
        token: z.string().min(1).max(2000).optional(),
        token_placement: placement.optional(),
        token_param: z.string().max(120).nullable().optional(),
        payload_template: z.string().min(1).max(20000).optional(),
        active: z.boolean().optional(),
      }).parse(req.body);
      const trig = await updateTrigger(app.pool, app.cfg.encKey, ctx.tenantId, id, {
        label: b.label, url: b.url, token: b.token, tokenPlacement: b.token_placement,
        tokenParam: b.token_param, payloadTemplate: b.payload_template, active: b.active,
      });
      if (!trig) throw new AppError('not_found', 404, 'Trigger not found');
      reply.send({ trigger: trig });
    } catch (e) { sendError(reply, e); }
  });

  app.delete('/api/jobix-triggers/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const ok = await deleteTrigger(app.pool, ctx.tenantId, (req.params as { id: string }).id);
      if (!ok) throw new AppError('not_found', 404, 'Trigger not found');
      reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/jobix-triggers/:id/test', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const id = (req.params as { id: string }).id;
      const b = z.object({ vars: varsSchema }).parse(req.body ?? {});
      const result = await fireTrigger(app.pool, app.cfg.encKey, { tenantId: ctx.tenantId, triggerId: id, vars: b.vars, source: 'test', userId: ctx.userId });
      reply.send({ result });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/jobix-triggers/:id/fire', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const id = (req.params as { id: string }).id;
      const b = z.object({ vars: varsSchema }).parse(req.body ?? {});
      const result = await fireTrigger(app.pool, app.cfg.encKey, { tenantId: ctx.tenantId, triggerId: id, vars: b.vars, source: 'manual', userId: ctx.userId });
      reply.send({ result });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/jobix-triggers/:id/fires', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const id = (req.params as { id: string }).id;
      const q = z.object({ limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional() }).parse(req.query);
      reply.send(await listFires(app.pool, ctx.tenantId, id, q));
    } catch (e) { sendError(reply, e); }
  });
}
