import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { sendError, AppError } from '@aiployee/core';
import { generateApiKey, hashApiKey, prefixOf } from '../auth/apiKey.js';
import { insertApiKey, listApiKeys, revokeApiKey, getApiKeyById, deleteApiKeyPermanent } from '../repos/apiKeys.js';

const CreateBody = z.object({ name: z.string().min(1), parentId: z.string().uuid().optional() });

export async function registerApiKeyRoutes(app: FastifyInstance) {
  app.get('/api/api-keys', async (req, reply) => {
    try { const ctx = requireTenantCtx(req); reply.send({ keys: await listApiKeys(app.pool, ctx.tenantId) }); }
    catch (e) { sendError(reply, e); }
  });

  app.post('/api/api-keys', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const body = CreateBody.parse(req.body);
      if (body.parentId) {
        const parent = await getApiKeyById(app.pool, ctx.tenantId, body.parentId);
        if (!parent) throw new AppError('not_found', 404, 'Parent key not found');
        if (parent.revoked_at) throw new AppError('invalid_parent', 400, 'Parent key is revoked');
        if (parent.parent_id) throw new AppError('invalid_parent', 400, 'Sub-keys cannot have sub-keys');
      }
      const plaintext = generateApiKey();
      const row = await insertApiKey(app.pool, {
        tenantId: ctx.tenantId, name: body.name,
        keyHash: hashApiKey(plaintext), keyPrefix: prefixOf(plaintext),
        parentId: body.parentId ?? null,
      });
      return reply.code(201).send({ key: row, plaintext });
    } catch (e) { sendError(reply, e); }
  });

  app.delete('/api/api-keys/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      // Revoking a master cascades to its sub-keys (handled in revokeApiKey).
      const ok = await revokeApiKey(app.pool, ctx.tenantId, id);
      if (!ok) throw new AppError('not_found', 404, 'API key not found or already revoked');
      return reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });

  // Permanent hard-delete — only allowed once the key is revoked. Deleting a
  // master cascades its sub-keys; referencing email rows keep api_key_id = NULL.
  app.delete('/api/api-keys/:id/permanent', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const ok = await deleteApiKeyPermanent(app.pool, ctx.tenantId, id);
      if (!ok) throw new AppError('not_found', 404, 'API key not found or not revoked');
      return reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });
}
