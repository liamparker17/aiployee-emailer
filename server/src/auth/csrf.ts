import type { FastifyInstance } from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE = 'aip_csrf';
const HEADER = 'x-csrf-token';

export function registerCsrf(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    const existing = req.cookies[COOKIE];
    if (!existing) {
      const token = randomBytes(24).toString('base64url');
      reply.setCookie(COOKIE, token, {
        path: '/', sameSite: 'lax', httpOnly: false,
        secure: app.cfg.env === 'production',
      });
      (req as unknown as { csrfToken: string }).csrfToken = token;
    } else {
      (req as unknown as { csrfToken: string }).csrfToken = existing;
    }
  });
  app.addHook('preHandler', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    if (req.url.startsWith('/v1/')) return; // API key routes use bearer auth, not CSRF
    if (req.url === '/healthz') return;
    // Invite acceptance is authorized by the single-use invite token in the body, not by
    // an ambient session cookie — so CSRF double-submit adds no protection and would break
    // it when the emailed link is opened directly (the aip_csrf cookie isn't set yet).
    if (req.url.split('?')[0] === '/auth/invite/accept') return;
    const cookie = req.cookies[COOKIE];
    const header = req.headers[HEADER];
    const headerStr = Array.isArray(header) ? header[0] : header;
    let ok = false;
    if (cookie && headerStr) {
      const a = Buffer.from(cookie);
      const b = Buffer.from(headerStr);
      ok = a.length === b.length && timingSafeEqual(a, b);
    }
    if (!ok) {
      return reply.code(403).send({ error: { code: 'csrf_invalid', message: 'CSRF token missing or invalid' } });
    }
  });
}
