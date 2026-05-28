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
    if (req.url === '/healthz' || req.url.startsWith('/v1/webhooks/') || req.url.startsWith('/v1/cron/')) return;

    if (req.url.startsWith('/v1/')) {
      // Resolve the API key in precedence order: api_key, X-Api-Key, Authorization: Bearer.
      // The api_key header matches Jobix's default header field; the others are common conventions.
      function pick(h: string | string[] | undefined): string | null {
        if (!h) return null;
        const v = Array.isArray(h) ? h[0] : h;
        const trimmed = typeof v === 'string' ? v.trim() : '';
        return trimmed.length ? trimmed : null;
      }
      const auth = req.headers.authorization;
      const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null;
      const key = pick(req.headers['api_key']) ?? pick(req.headers['x-api-key']) ?? (bearer && bearer.length ? bearer : null);
      if (!key) {
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'Missing API key (api_key, X-Api-Key, or Authorization: Bearer)' } });
      }
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
        // Path-only check (req.url may carry a query string).
        const path = req.url.split('?')[0];
        if (path === '/auth/login' || path === '/auth/invite/accept' || path === '/api/me') return;
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'Not signed in' } });
      }
      const role = sess.role!;
      const effectiveTenantId =
        role === 'super_admin'
          ? (sess.activeTenantId ?? '')
          : (sess.tenantId ?? '');
      req.ctx = {
        tenantId: effectiveTenantId,
        userId: sess.userId,
        role,
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
  if (!ctx.tenantId) {
    throw new AppError('no_active_tenant', 400, 'No active tenant. Set one via POST /api/session/active-tenant.');
  }
  return ctx as Ctx & { tenantId: string };
}

export function requireSuperAdmin(req: FastifyRequest): Ctx {
  const ctx = requireCtx(req);
  if (ctx.role !== 'super_admin') throw new AppError('forbidden', 403, 'Super admin required');
  return ctx;
}
