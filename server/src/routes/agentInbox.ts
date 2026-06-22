import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx, AppError, sendError } from '@aiployee/core';
import {
  listThreads, getThread, setThreadOwner,
  type ThreadStage, type ThreadStatus,
} from '../repos/agentThreads.js';
import {
  listActions, getAction, approveAction, rejectAction, editActionDraft, assignAction, snoozeAction,
  type ActionStatus,
} from '../repos/agentActions.js';
import { executeApprovedAction } from '../agent/abe/executeAction.js';

const AssignBody = z.object({ user_id: z.string().uuid() });
const EditBody = z.object({ subject: z.string().optional(), body: z.string().optional() });
const SnoozeBody = z.object({ until: z.string().datetime() });

function requireAdmin(ctx: { role: string }): void {
  if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') {
    throw new AppError('forbidden', 403, 'Admin role required');
  }
}

export function registerAgentInboxRoutes(app: FastifyInstance): void {
  app.get('/api/agent/inbox/threads', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const q = req.query as Record<string, string | undefined>;
      const threads = await listThreads(app.pool, ctx.tenantId, {
        stage: q.stage as ThreadStage | undefined,
        status: q.status as ThreadStatus | undefined,
        ownerId: q.owner,
        dueBefore: q.due_before ? new Date(q.due_before) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
      });
      return reply.send({ threads });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/agent/inbox/threads/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const thread = await getThread(app.pool, ctx.tenantId, id);
      if (!thread) throw new AppError('not_found', 404, 'Thread not found');
      const actions = await listActions(app.pool, ctx.tenantId, {});
      return reply.send({ thread, actions: actions.filter(a => a.thread_id === id) });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/agent/inbox/threads/:id/assign', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const { id } = req.params as { id: string };
      const body = AssignBody.parse(req.body);
      await setThreadOwner(app.pool, ctx.tenantId, id, body.user_id);
      return reply.send({ thread: await getThread(app.pool, ctx.tenantId, id) });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/agent/inbox/actions', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const q = req.query as Record<string, string | undefined>;
      const actions = await listActions(app.pool, ctx.tenantId, {
        status: q.status as ActionStatus | undefined,
        limit: q.limit ? Number(q.limit) : undefined,
      });
      return reply.send({ actions });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/agent/inbox/actions/:id/approve', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const { id } = req.params as { id: string };
      const existing = await getAction(app.pool, ctx.tenantId, id);
      if (!existing) throw new AppError('not_found', 404, 'Action not found');
      if (!ctx.userId) throw new AppError('unauthorized', 401, 'User context required');
      await approveAction(app.pool, ctx.tenantId, id, ctx.userId);
      const { emailId } = await executeApprovedAction({ pool: app.pool, tenantId: ctx.tenantId, actionId: id });
      return reply.send({ action: await getAction(app.pool, ctx.tenantId, id), emailId });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/agent/inbox/actions/:id/reject', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const { id } = req.params as { id: string };
      await rejectAction(app.pool, ctx.tenantId, id);
      return reply.send({ action: await getAction(app.pool, ctx.tenantId, id) });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/agent/inbox/actions/:id/edit', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const { id } = req.params as { id: string };
      const body = EditBody.parse(req.body);
      await editActionDraft(app.pool, ctx.tenantId, id, body);
      return reply.send({ action: await getAction(app.pool, ctx.tenantId, id) });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/agent/inbox/actions/:id/assign', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const { id } = req.params as { id: string };
      const body = AssignBody.parse(req.body);
      await assignAction(app.pool, ctx.tenantId, id, body.user_id);
      return reply.send({ action: await getAction(app.pool, ctx.tenantId, id) });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/agent/inbox/actions/:id/snooze', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const { id } = req.params as { id: string };
      const body = SnoozeBody.parse(req.body);
      await snoozeAction(app.pool, ctx.tenantId, id, new Date(body.until));
      return reply.send({ action: await getAction(app.pool, ctx.tenantId, id) });
    } catch (e) { sendError(reply, e); }
  });
}
