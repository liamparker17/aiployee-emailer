import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { AppError, sendError } from '../util/errors.js';
import { getGoal, upsertGoal, markManagerVerified } from '../repos/agentGoals.js';
import { verifyApprovalToken, hashToken, tokenHashesEqual } from '../agent/abe/approvalToken.js';
import { sendManagerVerifyEmail } from '../agent/abe/approvalEmail.js';
import { listPlays, getPlay, setPlayStatus } from '../repos/agentPlays.js';
import { startPlayExecution } from '../agent/abe/execute.js';
import { getActiveApprovalByPlay, consumeApproval } from '../repos/agentApprovals.js';
import { buildFeed } from '../agent/abe/feed.js';
import { getPlayOutcomes } from '../repos/agentOutcomes.js';

const GoalBody = z.object({
  enabled: z.boolean().optional(),
  dormantWindowDays: z.number().int().min(1).max(3650).optional(),
  autoFireMaxAudience: z.number().int().min(0).optional(),
  maxTouches: z.number().int().min(1).max(5).optional(),
  touchSpacingDays: z.number().int().min(1).max(60).optional(),
  lineManagerEmail: z.string().email().nullable().optional(),
  brandVoice: z.string().max(2000).nullable().optional(),
});

export function registerAbeRoutes(app: FastifyInstance): void {
  app.get('/api/agent/goals', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const goal = await getGoal(app.pool, ctx.tenantId);
      return reply.send({ goal });
    } catch (e) { sendError(reply, e); }
  });

  app.put('/api/agent/goals', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') {
        throw new AppError('forbidden', 403, 'Admin role required');
      }
      const body = GoalBody.parse(req.body);
      const goal = await upsertGoal(app.pool, ctx.tenantId, body);
      return reply.send({ goal });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/agent/plays', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const plays = await listPlays(app.pool, ctx.tenantId);
      return reply.send({ plays });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/agent/plays/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const play = await getPlay(app.pool, ctx.tenantId, id);
      if (!play) throw new AppError('not_found', 404, 'Play not found');
      const outcomes = await getPlayOutcomes(app.pool, ctx.tenantId, id);
      return reply.send({ play, outcomes });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/agent/feed', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const feed = await buildFeed(app.pool, ctx.tenantId);
      return reply.send({ feed });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/agent/plays/:id/approve', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') throw new AppError('forbidden', 403, 'Admin role required');
      const { id } = req.params as { id: string };
      const play = await getPlay(app.pool, ctx.tenantId, id);
      if (!play) throw new AppError('not_found', 404, 'Play not found');
      if (play.status !== 'proposed' && play.status !== 'pending_approval') {
        throw new AppError('conflict', 409, `Play not approvable (status ${play.status})`);
      }
      const { queued } = await startPlayExecution({ pool: app.pool, encKey: app.cfg.encKey, baseUrl: app.cfg.publicBaseUrl, play });
      const updated = await getPlay(app.pool, ctx.tenantId, id);
      return reply.send({ play: updated, queued });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/agent/plays/:id/reject', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') throw new AppError('forbidden', 403, 'Admin role required');
      const { id } = req.params as { id: string };
      const { reason } = (req.body ?? {}) as { reason?: string };
      const play = await getPlay(app.pool, ctx.tenantId, id);
      if (!play) throw new AppError('not_found', 404, 'Play not found');
      const upd = await app.pool.query(
        `UPDATE agent_plays SET status = 'rejected', rejection_reason = $3, updated_at = now()
           WHERE tenant_id = $1 AND id = $2 RETURNING *`, [ctx.tenantId, id, reason ?? null]);
      return reply.send({ play: upd.rows[0] });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/agent/goals/verify-manager', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') {
        throw new AppError('forbidden', 403, 'Admin role required');
      }
      const goal = await getGoal(app.pool, ctx.tenantId);
      if (!goal?.line_manager_email) {
        throw new AppError('no_manager_email', 400, 'No line manager email is set on the goal');
      }
      const res = await sendManagerVerifyEmail({
        pool: app.pool, encKey: app.cfg.encKey, baseUrl: app.cfg.publicBaseUrl,
        tenantId: ctx.tenantId, managerEmail: goal.line_manager_email,
      });
      if (!res.sent) {
        throw new AppError('no_default_sender', 400, 'No default sender configured; cannot send verify email');
      }
      return reply.send({ sent: true });
    } catch (e) { sendError(reply, e); }
  });

  // ── Public approve / reject / view (auth-exempt via /v1/agent/ exclusion) ────────
  app.get('/v1/agent/approve/:token', async (req, reply) => {
    const page = (title: string, body: string) =>
      `<!doctype html><html><body style="font-family:system-ui,sans-serif;text-align:center;padding:48px;color:#1a0f3d;max-width:560px;margin:0 auto"><h2>${title}</h2>${body}</body></html>`;
    const fail = (msg: string) => reply.code(400).type('text/html').send(page('Link unavailable', `<p>${msg}</p>`));

    try {
      const { token } = req.params as { token: string };
      const { d } = req.query as { d?: string };
      if (d !== 'approve' && d !== 'reject' && d !== 'view') return fail('Unrecognised action.');

      const parsed = verifyApprovalToken(token, app.cfg.encKey);
      if (!parsed) return fail('This approval link is invalid or has expired.');

      // parsed.id is the playId. Find the active (unconsumed) approval and validate the hash.
      const approval = await getActiveApprovalByPlay(app.pool, parsed.id);
      if (!approval || !tokenHashesEqual(approval.token_hash, hashToken(token))) {
        return fail('This approval link has already been used or is no longer valid.');
      }
      const play = await getPlay(app.pool, approval.tenant_id, parsed.id);
      if (!play || play.status !== 'pending_approval') {
        return fail('This campaign is no longer awaiting approval.');
      }

      if (d === 'view') {
        const audienceSize = play.audience_snapshot.size;
        const touches = play.touches
          .map((t) => `<li>Touch ${t.index + 1} (day ${t.scheduled_offset_days})</li>`)
          .join('');
        const base = `${app.cfg.publicBaseUrl}/v1/agent/approve/${encodeURIComponent(token)}`;
        return reply.type('text/html').send(page(
          'Re-engage campaign',
          `<p>${audienceSize} dormant contact(s), ${play.touches.length} touch(es).</p><ul style="text-align:left;display:inline-block">${touches}</ul>
           <p style="margin-top:24px">
             <a href="${base}?d=approve" style="background:#2e7d32;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;margin-right:8px">Approve</a>
             <a href="${base}?d=reject" style="background:#c62828;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Reject</a>
           </p>`,
        ));
      }

      if (d === 'reject') {
        const consumed = await consumeApproval(app.pool, approval.id, 'reject');
        if (!consumed) return fail('This approval link has already been used.');
        await setPlayStatus(app.pool, approval.tenant_id, play.id, 'rejected', 'Rejected by line manager over email');
        return reply.type('text/html').send(page('Campaign rejected', '<p>Thanks — the campaign will not be sent.</p>'));
      }

      // d === 'approve'. Consume first (single-use guard); a losing race returns null.
      const consumed = await consumeApproval(app.pool, approval.id, 'approve');
      if (!consumed) return fail('This approval link has already been used.');
      await startPlayExecution({ pool: app.pool, encKey: app.cfg.encKey, baseUrl: app.cfg.publicBaseUrl, play });
      return reply.type('text/html').send(page('Campaign approved', '<p>Thanks — Abe is sending the campaign now.</p>'));
    } catch {
      return reply.code(400).type('text/html').send(page('Link unavailable', '<p>Something went wrong with this link.</p>'));
    }
  });

  // ── Public manager-verify (auth-exempt via /v1/agent/ exclusion; no session) ─────
  app.get('/v1/agent/verify-manager/:token', async (req, reply) => {
    const page = (msg: string) =>
      `<!doctype html><html><body style="font-family:system-ui,sans-serif;text-align:center;padding:48px;color:#1a0f3d"><h2>${msg}</h2></body></html>`;
    try {
      const { token } = req.params as { token: string };
      const parsed = verifyApprovalToken(token, app.cfg.encKey);
      if (!parsed) return reply.code(400).type('text/html').send(page('This confirmation link is invalid or has expired.'));
      const ok = await markManagerVerified(app.pool, parsed.id);
      if (!ok) return reply.code(404).type('text/html').send(page('No matching approver to confirm.'));
      return reply.type('text/html').send(page("Thanks — your email is confirmed. You can now approve or reject campaigns."));
    } catch {
      return reply.code(400).type('text/html').send(page('This confirmation link is invalid or has expired.'));
    }
  });
}
