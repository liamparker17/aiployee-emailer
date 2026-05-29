import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireCtx, requireTenantCtx } from '../auth/ctx.js';
import { sendError, AppError } from '../util/errors.js';
import { runAgentTurn } from '../agent/runner.js';
import {
  getAgentConfig, upsertAgentConfig, upsertThread, insertMessage, findMessageByRef,
  listThreads, getThread, listThreadMessages, getMessage, setMessageStatus,
} from '../repos/agent.js';

function requireAdmin(req: FastifyRequest) {
  const ctx = requireTenantCtx(req);
  if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') {
    throw new AppError('forbidden', 403, 'Admin role required');
  }
  return ctx;
}

const IngestBody = z.object({
  thread_ref: z.string().min(1),
  message: z.string().min(1),
  subject: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  message_ref: z.string().optional(),
});

const ConfigBody = z.object({
  enabled: z.boolean(),
  model: z.string().min(1),
  systemPrompt: z.string().default(''),
  autoApproveJobix: z.boolean().default(true),
  maxToolIterations: z.number().int().min(1).max(20).default(4),
  openaiKey: z.string().min(1).optional(), // only sent when (re)setting the key
});

export async function registerAgentRoutes(app: FastifyInstance) {
  // ── Jobix → agent: ingest a message into a thread and run one agent turn ──────
  app.post('/v1/agent/messages', async (req, reply) => {
    try {
      const ctx = requireCtx(req);
      if (ctx.role !== 'api_key') throw new AppError('unauthorized', 401, 'API key required');
      const body = IngestBody.parse(req.body);

      // Idempotency: a repeated message_ref returns the original result.
      if (body.message_ref) {
        const existing = await findMessageByRef(app.pool, ctx.tenantId, body.message_ref);
        if (existing) {
          return reply.code(202).send({ thread_ref: body.thread_ref, message_id: existing.id, status: 'accepted', duplicate: true });
        }
      }

      const cfg = await getAgentConfig(app.pool, ctx.tenantId);
      if (!cfg || !cfg.enabled) throw new AppError('agent_disabled', 400, 'Agent is not enabled for this tenant');

      const thread = await upsertThread(app.pool, ctx.tenantId, body.thread_ref, body.subject);
      const content = body.context && Object.keys(body.context).length
        ? `${body.message}\n\nContext:\n${JSON.stringify(body.context, null, 2)}`
        : body.message;
      await insertMessage(app.pool, {
        threadId: thread.id, tenantId: ctx.tenantId, role: 'inbound', source: 'jobix',
        content, status: 'approved', messageRef: body.message_ref,
      });

      const { message } = await runAgentTurn({
        pool: app.pool, encKey: app.cfg.encKey, tenantId: ctx.tenantId,
        threadId: thread.id, triggerSource: 'jobix', llmFactory: app.agentLlmFactory,
      });

      // Phase 1 runs synchronously and returns the reply inline (outbound webhooks land in Phase 2).
      return reply.code(202).send({
        thread_ref: body.thread_ref,
        message_id: message.id,
        status: message.status === 'pending_approval' ? 'drafted' : 'sent',
        response_text: message.content,
      });
    } catch (e) { sendError(reply, e); }
  });

  // ── Session UI: config ────────────────────────────────────────────────────────
  app.get('/api/agent/config', async (req, reply) => {
    try {
      const ctx = requireAdmin(req);
      const cfg = await getAgentConfig(app.pool, ctx.tenantId);
      return reply.send({ config: cfg });
    } catch (e) { sendError(reply, e); }
  });

  app.put('/api/agent/config', async (req, reply) => {
    try {
      const ctx = requireAdmin(req);
      const body = ConfigBody.parse(req.body);
      const cfg = await upsertAgentConfig(app.pool, app.cfg.encKey, ctx.tenantId, body);
      return reply.send({ config: cfg });
    } catch (e) { sendError(reply, e); }
  });

  // ── Session UI: threads + approval ─────────────────────────────────────────────
  app.get('/api/agent/threads', async (req, reply) => {
    try {
      const ctx = requireAdmin(req);
      return reply.send({ threads: await listThreads(app.pool, ctx.tenantId) });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/agent/threads/:id', async (req, reply) => {
    try {
      const ctx = requireAdmin(req);
      const { id } = req.params as { id: string };
      const thread = await getThread(app.pool, ctx.tenantId, id);
      if (!thread) throw new AppError('not_found', 404, 'Thread not found');
      return reply.send({ thread, messages: await listThreadMessages(app.pool, id) });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/agent/messages/:id/approve', async (req, reply) => {
    try {
      const ctx = requireAdmin(req);
      const { id } = req.params as { id: string };
      const msg = await getMessage(app.pool, ctx.tenantId, id);
      if (!msg) throw new AppError('not_found', 404, 'Message not found');
      if (msg.status !== 'pending_approval') throw new AppError('not_pending', 400, 'Message is not pending approval');
      await setMessageStatus(app.pool, ctx.tenantId, id, 'approved', ctx.userId);
      return reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/agent/messages/:id/reject', async (req, reply) => {
    try {
      const ctx = requireAdmin(req);
      const { id } = req.params as { id: string };
      const msg = await getMessage(app.pool, ctx.tenantId, id);
      if (!msg) throw new AppError('not_found', 404, 'Message not found');
      if (msg.status !== 'pending_approval') throw new AppError('not_pending', 400, 'Message is not pending approval');
      await setMessageStatus(app.pool, ctx.tenantId, id, 'rejected', ctx.userId);
      return reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });
}
