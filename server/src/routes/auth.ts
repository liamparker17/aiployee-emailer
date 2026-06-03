import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyPassword, hashPassword } from '../auth/password.js';
import { AppError, sendError } from '../util/errors.js';

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });
const AcceptBody = z.object({ token: z.string().min(10), password: z.string().min(8) });

export async function registerAuthRoutes(app: FastifyInstance) {
  app.post('/auth/login', async (req, reply) => {
    try {
      const body = LoginBody.parse(req.body);
      // The same email can have several rows (a global super_admin + tenant memberships).
      // Match case-insensitively, prefer the highest-privilege row, and log in as the
      // first row whose password verifies — so a super_admin always lands as super_admin.
      const r = await app.pool.query<{ id: string; tenant_id: string | null; password_hash: string; role: string }>(
        `SELECT id, tenant_id, password_hash, role FROM users WHERE lower(email) = lower($1)
         ORDER BY CASE role WHEN 'super_admin' THEN 0 WHEN 'tenant_admin' THEN 1 ELSE 2 END, created_at ASC`,
        [body.email],
      );
      let u: { id: string; tenant_id: string | null; password_hash: string; role: string } | undefined;
      for (const row of r.rows) {
        if (await verifyPassword(body.password, row.password_hash)) { u = row; break; }
      }
      if (!u) {
        throw new AppError('invalid_credentials', 401, 'Invalid email or password');
      }
      req.session.userId = u.id;
      req.session.tenantId = u.tenant_id;
      req.session.role = u.role as never;
      req.session.activeTenantId = undefined;
      await req.session.save();
      return reply.send({ user: { id: u.id, email: body.email, role: u.role, tenantId: u.tenant_id } });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/me', async (req, reply) => {
    const sess = req.session;
    if (!sess?.userId) return reply.send({ user: null });
    return reply.send({ user: {
      id: sess.userId,
      email: '',
      role: sess.role,
      tenantId: sess.tenantId ?? null,
    }});
  });

  app.post('/auth/logout', async (req, reply) => {
    await req.session.destroy();
    return reply.send({ ok: true });
  });

  app.post('/auth/invite/accept', async (req, reply) => {
    try {
      const body = AcceptBody.parse(req.body);
      const r = await app.pool.query<{ id: string }>(
        `UPDATE users
         SET password_hash = $2, invite_token = NULL, invite_expires_at = NULL
         WHERE invite_token = $1 AND invite_expires_at > now()
         RETURNING id`,
        [body.token, await hashPassword(body.password)],
      );
      if (r.rowCount === 0) throw new AppError('invalid_token', 400, 'Invite token invalid or expired');
      return reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });
}
