import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyPassword, hashPassword } from '@aiployee/core';
import { AppError, sendError } from '@aiployee/core';
import { findUsersByEmail, issuePasswordReset } from '../repos/users.js';
import { getDefaultSender, getSenderByEmailAnyTenant } from '../repos/senders.js';
import { insertEmail } from '../repos/emails.js';
import { dispatchEmail } from '../send/dispatch.js';

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });
const AcceptBody = z.object({ token: z.string().min(10), password: z.string().min(8) });
const ForgotBody = z.object({ email: z.string().email() });

const RESET_TTL_MINUTES = 60;

// Platform sender for password-reset mail. Must exist as a configured sender on
// some tenant; lives in env rather than Config so this stays independent of
// per-tenant setup. Override with SYSTEM_SENDER_EMAIL.
const SYSTEM_SENDER_EMAIL = process.env.SYSTEM_SENDER_EMAIL?.trim() || 'liam@aiployee.co.za';

// Per-address throttle so the endpoint can't be used to spam someone's inbox.
// In-memory (per serverless instance) — a coarse net, not a security boundary;
// the real bounds are the short token TTL and single use.
const lastResetSentAt = new Map<string, number>();
const RESET_THROTTLE_MS = 60_000;

function resetEmailHtml(url: string): string {
  return `<p>We received a request to reset your Aiployee password.</p>
<p><a href="${url}">Choose a new password</a></p>
<p>This link expires in ${RESET_TTL_MINUTES} minutes and can be used once. If you didn't request it, you can ignore this email — your password stays unchanged.</p>`;
}

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

  // Always answers 200 regardless of whether the address exists, so the endpoint
  // can't be used to enumerate accounts. Failures are logged, never returned.
  app.post('/auth/forgot-password', async (req, reply) => {
    try {
      const body = ForgotBody.parse(req.body);
      const email = body.email.trim().toLowerCase();

      const last = lastResetSentAt.get(email);
      if (last && Date.now() - last < RESET_THROTTLE_MS) return reply.send({ ok: true });

      const rows = await findUsersByEmail(app.pool, email);
      const target = rows[0];
      if (!target) return reply.send({ ok: true });

      // Reset mail goes out through the platform sender, not the tenant's, so the
      // flow also works for super_admin accounts (tenant_id NULL, no tenant sender
      // of their own). Fall back to the tenant default only if that isn't set up.
      const sender = (await getSenderByEmailAnyTenant(app.pool, SYSTEM_SENDER_EMAIL))
        ?? (target.tenant_id ? await getDefaultSender(app.pool, target.tenant_id) : null);
      if (!sender) {
        req.log?.error?.({ systemSender: SYSTEM_SENDER_EMAIL }, 'no sender available to send password reset');
        return reply.send({ ok: true });
      }

      const token = await issuePasswordReset(app.pool, target.id, RESET_TTL_MINUTES);
      if (!token) return reply.send({ ok: true });

      lastResetSentAt.set(email, Date.now());
      const url = `${app.cfg.publicBaseUrl}/accept-invite?token=${token}`;
      const record = await insertEmail(app.pool, {
        tenantId: sender.tenant_id, senderId: sender.id, toAddr: email,
        subject: 'Reset your Aiployee password',
        bodyHtml: resetEmailHtml(url),
        bodyText: `Reset your Aiployee password: ${url}\n\nThis link expires in ${RESET_TTL_MINUTES} minutes and can be used once.`,
        status: 'queued',
      });
      const outcome = await dispatchEmail({
        pool: app.pool, encKey: app.cfg.encKey, email: record, baseUrl: app.cfg.publicBaseUrl,
      });
      if (!outcome.ok) req.log?.error?.({ err: outcome.error }, 'password reset email failed to send');
      return reply.send({ ok: true });
    } catch (e) {
      // Malformed body still gets the generic answer; anything else is ours to log.
      if (!(e instanceof z.ZodError)) req.log?.error?.({ err: e }, 'forgot-password failed');
      return reply.send({ ok: true });
    }
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
