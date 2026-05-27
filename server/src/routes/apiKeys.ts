import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { sendError, AppError } from '../util/errors.js';
import { generateApiKey, hashApiKey, prefixOf } from '../auth/apiKey.js';
import { insertApiKey, listApiKeys, revokeApiKey } from '../repos/apiKeys.js';

const CreateBody = z.object({ name: z.string().min(1) });

export async function registerApiKeyRoutes(app: FastifyInstance) {
  app.get('/api/api-keys', async (req, reply) => {
    try { const ctx = requireTenantCtx(req); reply.send({ keys: await listApiKeys(app.pool, ctx.tenantId) }); }
    catch (e) { sendError(reply, e); }
  });

  app.post('/api/api-keys', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const body = CreateBody.parse(req.body);
      const plaintext = generateApiKey();
      const row = await insertApiKey(app.pool, {
        tenantId: ctx.tenantId, name: body.name,
        keyHash: hashApiKey(plaintext), keyPrefix: prefixOf(plaintext),
      });
      return reply.code(201).send({ key: row, plaintext });
    } catch (e) { sendError(reply, e); }
  });

  app.delete('/api/api-keys/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const ok = await revokeApiKey(app.pool, ctx.tenantId, id);
      if (!ok) throw new AppError('not_found', 404, 'API key not found or already revoked');
      return reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });
}
