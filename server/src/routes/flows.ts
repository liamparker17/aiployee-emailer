import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '@aiployee/core';
import { AppError, sendError } from '@aiployee/core';
import {
  createFlow, listFlows, getFlow, renameFlow, replaceSteps,
  activateFlow, pauseFlow, archiveFlow,
  enroll, listEnrollments, enrollmentCounts,
  type StepKind,
} from '../repos/flows.js';

function requireAdmin(ctx: ReturnType<typeof requireTenantCtx>): void {
  if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') {
    throw new AppError('forbidden', 403, 'Admin role required');
  }
}

// v1 exposes wait / jobix_call / condition / whatsapp_send. ('email' exists in the schema for a later slice.)
const stepSchema = z.object({
  kind: z.enum(['wait', 'jobix_call', 'condition', 'whatsapp_send']),
  config: z.record(z.unknown()).default({}),
}).superRefine((s, ctx) => {
  if (s.kind === 'jobix_call' && !s.config.triggerId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'jobix_call step requires config.triggerId' });
  }
  if (s.kind === 'whatsapp_send' && !(typeof s.config.message === 'string' && s.config.message.trim())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'whatsapp_send step requires config.message' });
  }
});

const recipientSchema = z.object({
  name: z.string().max(200).default(''),
  phone: z.string().max(60).default(''),
  email: z.string().max(200).optional(),
  context: z.record(z.unknown()).optional(),
});

export function registerFlowRoutes(app: FastifyInstance): void {
  app.post('/api/flows', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const b = z.object({ name: z.string().min(1).max(160) }).parse(req.body);
      const flow = await createFlow(app.pool, { tenantId: ctx.tenantId, name: b.name, createdBy: ctx.userId });
      reply.code(201).send({ flow });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/flows', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      reply.send({ flows: await listFlows(app.pool, ctx.tenantId) });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/flows/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const id = (req.params as { id: string }).id;
      const out = await getFlow(app.pool, ctx.tenantId, id);
      if (!out) throw new AppError('not_found', 404, 'Flow not found');
      const counts = await enrollmentCounts(app.pool, ctx.tenantId, id);
      reply.send({ ...out, counts });
    } catch (e) { sendError(reply, e); }
  });

  app.patch('/api/flows/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const id = (req.params as { id: string }).id;
      const b = z.object({ name: z.string().min(1).max(160) }).parse(req.body);
      const flow = await renameFlow(app.pool, ctx.tenantId, id, b.name);
      if (!flow) throw new AppError('not_found', 404, 'Flow not found');
      reply.send({ flow });
    } catch (e) { sendError(reply, e); }
  });

  app.put('/api/flows/:id/steps', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const id = (req.params as { id: string }).id;
      const b = z.object({ steps: z.array(stepSchema).max(50) }).parse(req.body);
      const steps = await replaceSteps(app.pool, ctx.tenantId, id,
        b.steps.map(s => ({ kind: s.kind as StepKind, config: s.config })));
      reply.send({ steps });
    } catch (e) { sendError(reply, e); }
  });

  const action = (path: string, fn: (tenantId: string, id: string) => Promise<unknown>) =>
    app.post(`/api/flows/:id/${path}`, async (req, reply) => {
      try {
        const ctx = requireTenantCtx(req); requireAdmin(ctx);
        reply.send({ flow: await fn(ctx.tenantId, (req.params as { id: string }).id) });
      } catch (e) { sendError(reply, e); }
    });
  action('activate', (tid, id) => activateFlow(app.pool, tid, id));
  action('pause', (tid, id) => pauseFlow(app.pool, tid, id));
  action('archive', (tid, id) => archiveFlow(app.pool, tid, id));

  app.post('/api/flows/:id/enroll', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const id = (req.params as { id: string }).id;
      const b = z.object({ recipients: z.array(recipientSchema).min(1).max(5000) }).parse(req.body);
      const result = await enroll(app.pool, { tenantId: ctx.tenantId, flowId: id, recipients: b.recipients });
      reply.send(result);
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/flows/:id/enrollments', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const id = (req.params as { id: string }).id;
      const q = z.object({
        status: z.enum(['active', 'completed', 'exited', 'failed']).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      }).parse(req.query);
      reply.send(await listEnrollments(app.pool, ctx.tenantId, id, q));
    } catch (e) { sendError(reply, e); }
  });
}
