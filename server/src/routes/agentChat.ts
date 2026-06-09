import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '@aiployee/core';
import { AppError, sendError } from '@aiployee/core';
import { listChatMessages } from '../repos/agentChat.js';
import { runAbeChat } from '../agent/abe/chat.js';

const ChatBody = z.object({ message: z.string().min(1).max(4000) });

export function registerAgentChatRoutes(app: FastifyInstance): void {
  app.get('/api/agent/chat', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') throw new AppError('forbidden', 403, 'Admin role required');
      const messages = await listChatMessages(app.pool, ctx.tenantId);
      return reply.send({ messages });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/agent/chat', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') throw new AppError('forbidden', 403, 'Admin role required');
      const { message } = ChatBody.parse(req.body);
      const { reply: text } = await runAbeChat({
        pool: app.pool, encKey: app.cfg.encKey, tenantId: ctx.tenantId,
        baseUrl: app.cfg.publicBaseUrl, userMessage: message, llmFactory: app.agentLlmFactory,
      });
      return reply.send({ reply: text });
    } catch (e) { sendError(reply, e); }
  });
}
