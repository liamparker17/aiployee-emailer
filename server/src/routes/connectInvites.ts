import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  requireTenantCtx, requireCtx, sendError, AppError,
  generateInviteToken, hashInviteToken, INVITE_TTL_MS, RateLimiter,
  startConnect, connectStatus, pgInviteStore,
  insertConnectInvite, listConnectInvites, revokeConnectInvite, deleteConnectInvite,
  createGraphSender, DEFAULT_MS_GRAPH_CLIENT_ID, DEFAULT_MS_TENANT,
  getSenderByEmailAnyTenant, getDefaultSender, insertEmail, dispatchEmail,
  type ConnectDeps, type FetchLike, type InviteRow, type ConnectNotice,
} from '@aiployee/core';
import { inviteEmail, adminNoticeEmail, type Mail } from '../connectInvite/mail.js';

const SYSTEM_SENDER_EMAIL = () => process.env.SYSTEM_SENDER_EMAIL?.trim() || 'liam@aiployee.co.za';

const CreateBody = z.object({
  mailbox: z.string().trim().email(),
  recipientEmail: z.string().trim().email(),
  displayName: z.string().trim().min(1).max(120).optional(),
  allowShared: z.boolean().default(false),
  tenantId: z.string().uuid().optional(),
});
const TokenBody = z.object({ token: z.string().min(1).max(200) });
const IdParam = z.object({ id: z.string().uuid() });

/** Send an email from the Emailer's own platform sender (same rule as password-reset mail). */
async function sendPlatformMail(app: FastifyInstance, fallbackTenantId: string, to: string, mail: Mail): Promise<boolean> {
  const sender = (await getSenderByEmailAnyTenant(app.pool, SYSTEM_SENDER_EMAIL()))
    ?? (fallbackTenantId ? await getDefaultSender(app.pool, fallbackTenantId) : null);
  if (!sender) { app.log.error({ systemSender: SYSTEM_SENDER_EMAIL() }, 'connect: no platform sender available'); return false; }
  const record = await insertEmail(app.pool, {
    tenantId: sender.tenant_id, senderId: sender.id, toAddr: to,
    subject: mail.subject, bodyHtml: mail.html, bodyText: mail.text, status: 'queued',
  });
  const outcome = await dispatchEmail({ pool: app.pool, encKey: app.cfg.encKey, email: record, baseUrl: app.cfg.publicBaseUrl });
  if (!outcome.ok) { app.log.error({ emailId: record.id }, 'connect: platform mail failed to send'); return false; }
  return true;
}

function clientIp(req: FastifyRequest): string {
  const h = (n: string) => { const v = req.headers[n]; return (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim(); };
  return h('x-vercel-forwarded-for') || h('x-real-ip') || req.ip || 'unknown';
}

export interface ConnectRouteOpts { fetchImpl?: FetchLike; now?: () => Date }

export async function registerConnectInviteRoutes(app: FastifyInstance, opts: ConnectRouteOpts = {}) {
  const limiter = new RateLimiter();

  const deps = (): ConnectDeps => ({
    store: pgInviteStore(app.pool),
    encKey: app.cfg.encKey,
    fetchImpl: opts.fetchImpl ?? (fetch as unknown as FetchLike),
    now: opts.now,
    log: app.log,
    clientId: DEFAULT_MS_GRAPH_CLIENT_ID,
    oauthTenant: DEFAULT_MS_TENANT,
    // Identical to POST /api/m365/graph-send/complete (createGraphSender with the same client + tenant).
    async createSender(inv: InviteRow, refreshToken: string) {
      const base = { tenantId: inv.tenant_id, username: inv.mailbox, fromDomain: inv.mailbox.split('@')[1] ?? '',
        displayName: inv.display_name, isDefault: false, clientId: DEFAULT_MS_GRAPH_CLIENT_ID,
        oauthTenant: DEFAULT_MS_TENANT, refreshToken };
      try {
        const r = await createGraphSender(app.pool, app.cfg.encKey, { ...base, name: inv.display_name });
        return { senderId: r.sender.id };
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e;
        // smtp_configs name already taken in this tenant: disambiguate with the address.
        const r = await createGraphSender(app.pool, app.cfg.encKey, { ...base, name: `${inv.display_name} (${inv.mailbox})` });
        return { senderId: r.sender.id };
      }
    },
    async notify(inv: InviteRow, n: ConnectNotice) {
      const mail = adminNoticeEmail(n.kind === 'connected'
        ? { mailbox: inv.mailbox, ok: true, signedInAs: n.signedInAs }
        : { mailbox: inv.mailbox, ok: false, reason: n.reason, signedInAs: n.signedInAs });
      await sendPlatformMail(app, inv.tenant_id, inv.created_by_email, mail);
    },
  });

  // ── admin (session auth + CSRF) ───────────────────────────────────────────────────────
  app.post('/api/m365/connect-invites', async (req, reply) => {
    try {
      const ctx = requireCtx(req);
      if (ctx.role !== 'super_admin' && ctx.role !== 'tenant_admin') throw new AppError('forbidden', 403, 'Admin required');
      const body = CreateBody.parse(req.body);
      let tenantId = ctx.tenantId;
      if (ctx.role === 'super_admin' && body.tenantId) tenantId = body.tenantId;
      else if (ctx.role !== 'super_admin' && body.tenantId && body.tenantId !== ctx.tenantId) throw new AppError('forbidden', 403, 'Wrong tenant');
      if (!tenantId) requireTenantCtx(req); // throws no_active_tenant
      const t = await app.pool.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [tenantId]);
      if (!t.rows[0]) throw new AppError('tenant_not_found', 404, 'Tenant not found');
      const u = ctx.userId
        ? await app.pool.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [ctx.userId])
        : { rows: [] as Array<{ email: string }> };
      const creatorEmail = u.rows[0]?.email;
      if (!creatorEmail) throw new AppError('no_creator', 400, 'Could not determine your email for notifications');

      const token = generateInviteToken();
      const now = (opts.now ?? (() => new Date()))();
      const inv = await insertConnectInvite(app.pool, {
        tenantId, mailbox: body.mailbox, recipientEmail: body.recipientEmail,
        displayName: body.displayName ?? body.mailbox, allowShared: body.allowShared,
        tokenHash: hashInviteToken(token), expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
        createdByUserId: ctx.userId ?? null, createdByEmail: creatorEmail,
      });
      const connectUrl = `${app.cfg.publicBaseUrl.replace(/\/+$/, '')}/connect/${token}`;
      const mail = inviteEmail({ mailbox: inv.mailbox, inviter: creatorEmail, company: t.rows[0].name, url: connectUrl, shared: inv.allow_shared });
      let emailSent = false;
      try { emailSent = await sendPlatformMail(app, tenantId, inv.recipient_email, mail); } catch { emailSent = false; }
      return reply.code(201).send({
        invite: { id: inv.id, tenantId: inv.tenant_id, mailbox: inv.mailbox, recipientEmail: inv.recipient_email,
          displayName: inv.display_name, allowShared: inv.allow_shared, status: inv.status, expiresAt: inv.expires_at },
        emailSent,
        // Returned once so the admin can paste it if the email does not arrive. It is never listed again.
        connectUrl,
      });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/m365/connect-invites', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      if (ctx.role !== 'super_admin' && ctx.role !== 'tenant_admin') throw new AppError('forbidden', 403, 'Admin required');
      return reply.send({ invites: await listConnectInvites(app.pool, ctx.tenantId) });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/m365/connect-invites/:id/revoke', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      if (ctx.role !== 'super_admin' && ctx.role !== 'tenant_admin') throw new AppError('forbidden', 403, 'Admin required');
      const { id } = IdParam.parse(req.params);
      const ok = await revokeConnectInvite(app.pool, ctx.tenantId, id);
      if (!ok) throw new AppError('not_found', 404, 'No pending invite found');
      return reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });
  void deleteConnectInvite; // exported for tests/cleanup; not exposed over HTTP

  // ── public (token in the POST body; no ambient session, so no CSRF cookie to forge) ─────
  const publicHandler = (kind: 'start' | 'status') => async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    try {
      const parsed = TokenBody.safeParse(req.body);
      const token = parsed.success ? parsed.data.token : '';
      const tkey = hashInviteToken(token || 'none');
      const ip = clientIp(req);
      const [tLimit, iLimit] = kind === 'start' ? [8, 30] : [40, 150];
      if (!limiter.allow(`${kind}:t:${tkey}`, tLimit, 60_000) || !limiter.allow(`${kind}:ip:${ip}`, iLimit, 60_000)) {
        return reply.code(429).header('Retry-After', '30').send({ error: { code: 'rate_limited', message: 'Too many requests. Please wait a moment.' } });
      }
      const view = kind === 'start' ? await startConnect(deps(), token) : await connectStatus(deps(), token);
      return reply.send(view);
    } catch (e) {
      req.log.error({ kind }, 'connect: public handler error'); // never log the body/token
      return sendError(reply, new AppError('internal', 500, 'Something went wrong. Please reload.'));
    }
  };
  app.post('/api/public/m365-connect/start', publicHandler('start'));
  app.post('/api/public/m365-connect/status', publicHandler('status'));
}
