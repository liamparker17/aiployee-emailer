import type { FastifyInstance, FastifyRequest } from 'fastify';
import { hashApiKey } from './apiKey.js';
import { AppError } from '../util/errors.js';

export interface Ctx {
  tenantId: string;            // empty string '' for super-admin
  userId?: string;
  apiKeyId?: string;
  role: 'super_admin' | 'tenant_admin' | 'tenant_user' | 'api_key';
}

declare module 'fastify' {
  interface FastifyRequest { ctx?: Ctx }
}

export function registerCtx(app: FastifyInstance) {
  app.addHook('preHandler', async (req: FastifyRequest, reply) => {
    if (req.url === '/healthz' || req.url.startsWith('/v1/webhooks/')) return;

    if (req.url.startsWith('/v1/')) {
      const auth = req.headers.authorization;
      if (!auth?.startsWith('Bearer ')) {
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'Missing bearer token' } });
      }
      const key = auth.slice(7).trim();
      const hash = hashApiKey(key);
      const r = await app.pool.query<{ id: string; tenant_id: string }>(
        `UPDATE api_keys SET last_used_at = now()
         WHERE key_hash = $1 AND revoked_at IS NULL
         RETURNING id, tenant_id`, [hash]);
      if (r.rowCount === 0) {
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'Invalid API key' } });
      }
      req.ctx = { tenantId: r.rows[0].tenant_id, apiKeyId: r.rows[0].id, role: 'api_key' };
      return;
    }

    if (req.url.startsWith('/api/') || req.url.startsWith('/auth/')) {
      const sess = req.session;
      if (!sess?.userId) {
        if (req.url === '/auth/login' || req.url === '/auth/invite/accept' || req.url === '/api/me') return;
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'Not signed in' } });
      }
      req.ctx = {
        tenantId: sess.tenantId ?? '',
        userId: sess.userId,
        role: sess.role!,
      };
    }
  });
}

export function requireCtx(req: FastifyRequest): Ctx {
  if (!req.ctx) throw new AppError('unauthorized', 401, 'No context');
  return req.ctx;
}

export function requireTenantCtx(req: FastifyRequest): Ctx & { tenantId: string } {
  const ctx = requireCtx(req);
  if (!ctx.tenantId && ctx.role !== 'super_admin') {
    throw new AppError('forbidden', 403, 'Tenant context required');
  }
  return ctx as Ctx & { tenantId: string };
}

export function requireSuperAdmin(req: FastifyRequest): Ctx {
  const ctx = requireCtx(req);
  if (ctx.role !== 'super_admin') throw new AppError('forbidden', 403, 'Super admin required');
  return ctx;
}
