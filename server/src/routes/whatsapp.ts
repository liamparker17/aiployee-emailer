import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '@aiployee/core';
import { AppError, sendError } from '@aiployee/core';
import {
  getConnection, upsertConnection, deleteConnection, getConnectionForSend, recordSendResult,
} from '../repos/whatsappConnections.js';
import { waSendMessage } from '../whatsapp/client.js';
import { validateTriggerUrl } from '../jobix/validateTriggerUrl.js';

function requireAdmin(ctx: ReturnType<typeof requireTenantCtx>): void {
  if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') {
    throw new AppError('forbidden', 403, 'Admin role required');
  }
}

export function registerWhatsappRoutes(app: FastifyInstance): void {
  app.get('/api/whatsapp/connection', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      reply.send({ connection: await getConnection(app.pool, ctx.tenantId) });
    } catch (e) { sendError(reply, e); }
  });

  app.put('/api/whatsapp/connection', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const b = z.object({
        base_url: z.string().min(8).max(300),
        api_key: z.string().min(8).max(200).optional(),
        from_number: z.string().max(60).nullable().optional(),
        active: z.boolean().optional(),
      }).parse(req.body);
      validateTriggerUrl(b.base_url.trim());
      const connection = await upsertConnection(app.pool, app.cfg.encKey, {
        tenantId: ctx.tenantId, baseUrl: b.base_url, apiKey: b.api_key,
        fromNumber: b.from_number, active: b.active, createdBy: ctx.userId,
      });
      reply.send({ connection });
    } catch (e) { sendError(reply, e); }
  });

  app.delete('/api/whatsapp/connection', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const deleted = await deleteConnection(app.pool, ctx.tenantId);
      if (!deleted) throw new AppError('not_found', 404, 'No WhatsApp connection');
      reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/whatsapp/test', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const b = z.object({
        to: z.string().regex(/^\+[1-9]\d{6,14}$/, 'E.164 number required (e.g. +27821234567)'),
        message: z.string().min(1).max(1000).default('Test message from the AIployee Command Centre.'),
      }).parse(req.body);
      const conn = await getConnectionForSend(app.pool, app.cfg.encKey, ctx.tenantId);
      if (!conn) throw new AppError('not_found', 404, 'No WhatsApp connection configured');
      const result = await waSendMessage(conn, { to: b.to, text: b.message, idempotencyKey: randomUUID() });
      await recordSendResult(app.pool, ctx.tenantId, result.ok, result.error);
      reply.send({ ok: result.ok, status: result.status, error: result.error, response: result.body });
    } catch (e) { sendError(reply, e); }
  });
}
