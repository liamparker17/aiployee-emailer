import type { FastifyInstance } from 'fastify';
import { issueHandoffToken, verifyHandoffToken } from '../auth/handoff.js';
import { getUserById } from '../repos/users.js';

// Origins allowed to send/receive a cross-app handoff. localhost entries support dev.
const APP_ORIGINS = [
  'https://aiployee-emailer.vercel.app',
  'https://aiployee-command-centre.vercel.app',
  'http://localhost:5173',
  'http://localhost:5174',
];

function isAllowed(to: string): boolean {
  return APP_ORIGINS.some((o) => to === o || to.startsWith(o + '/'));
}

export function registerHandoffRoutes(app: FastifyInstance) {
  // Issue a single-use handoff token for the logged-in user and redirect to the
  // destination app's accept endpoint. The destination must be allowlisted.
  app.get('/auth/handoff', async (req, reply) => {
    const userId = req.session?.userId;
    if (!userId) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'Login required' } });
    }
    const to = (req.query as { to?: string }).to;
    if (!to || !isAllowed(to)) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'Invalid handoff destination' } });
    }
    const token = issueHandoffToken(
      { userId, tenantId: req.session.tenantId ?? null },
      app.cfg.sessionSecret,
      60,
    );
    const dest = new URL('/auth/handoff/accept', to);
    dest.searchParams.set('token', token);
    return reply.redirect(dest.toString());
  });

  // Verify a handoff token, establish a session on THIS origin, and redirect home.
  app.get('/auth/handoff/accept', async (req, reply) => {
    const token = (req.query as { token?: string }).token;
    if (!token) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'Missing token' } });
    }
    let payload;
    try {
      payload = verifyHandoffToken(token, app.cfg.sessionSecret);
    } catch {
      return reply.code(401).send({ error: { code: 'invalid_token', message: 'Handoff failed' } });
    }
    // Single-use: insert the jti; a replay violates the PK and is rejected.
    try {
      await app.pool.query('INSERT INTO handoff_used_jti (jti) VALUES ($1)', [payload.jti]);
    } catch {
      return reply.code(401).send({ error: { code: 'replayed', message: 'Handoff token already used' } });
    }
    const user = await getUserById(app.pool, payload.userId);
    if (!user) {
      return reply.code(401).send({ error: { code: 'invalid_token', message: 'Unknown user' } });
    }
    req.session.userId = user.id;
    req.session.tenantId = payload.tenantId;
    req.session.role = user.role as never;
    req.session.activeTenantId = payload.tenantId ?? undefined;
    await req.session.save();
    return reply.redirect('/');
  });
}
