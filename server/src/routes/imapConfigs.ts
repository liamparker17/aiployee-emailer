import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '@aiployee/core';
import { sendError, AppError } from '@aiployee/core';
import {
  createImapConfig, listImapConfigs, getImapConfigWithPassword,
  setImapConfigEnabled, deleteImapConfig, suggestImapHost,
  getSmtpConfigWithPassword, imapflowConnect,
} from '@aiployee/core';

// Two ways to enable inbox monitoring:
//  - reuse: point at an existing SMTP config; we copy its credential and suggest
//    the IMAP host from the SMTP host (overridable). This is the primary flow —
//    most tenants' mailbox login is the same credential they send with.
//  - manual: full host/port/username/password, for mailboxes with separate IMAP creds.
const ReuseBody = z.object({
  smtpConfigId: z.string().uuid(),
  senderId: z.string().uuid().nullish(),
  host: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
});

const ManualBody = z.object({
  senderId: z.string().uuid().nullish(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
  username: z.string().min(1),
  password: z.string().min(1),
});

const PatchBody = z.object({ enabled: z.boolean() });

export async function registerImapConfigRoutes(app: FastifyInstance) {
  app.get('/api/imap-configs', async (req, reply) => {
    try { const ctx = requireTenantCtx(req); reply.send({ configs: await listImapConfigs(app.pool, ctx.tenantId) }); }
    catch (e) { sendError(reply, e); }
  });

  app.post('/api/imap-configs', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const body = req.body as Record<string, unknown>;

      let input: { host: string; port: number; secure: boolean; username: string; password: string; senderId: string | null };
      if (body && typeof body.smtpConfigId === 'string') {
        const parsed = ReuseBody.parse(body);
        const smtp = await getSmtpConfigWithPassword(app.pool, app.cfg.encKey, ctx.tenantId, parsed.smtpConfigId);
        if (!smtp) throw new AppError('not_found', 404, 'SMTP config not found');
        input = {
          host: parsed.host ?? suggestImapHost(smtp.host),
          port: parsed.port, secure: parsed.secure,
          username: smtp.username, password: smtp.password,
          senderId: parsed.senderId ?? null,
        };
      } else {
        const parsed = ManualBody.parse(body);
        // Same paste hygiene as SMTP configs: app passwords arrive with spaces.
        input = { ...parsed, password: parsed.password.replace(/\s+/g, ''), senderId: parsed.senderId ?? null };
      }

      const c = await createImapConfig(app.pool, app.cfg.encKey, { tenantId: ctx.tenantId, enabled: true, ...input });
      return reply.code(201).send({ config: c });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return sendError(reply, new AppError('duplicate', 409, 'Mailbox already monitored'));
      sendError(reply, e);
    }
  });

  app.patch('/api/imap-configs/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const body = PatchBody.parse(req.body);
      const c = await setImapConfigEnabled(app.pool, ctx.tenantId, id, body.enabled);
      if (!c) throw new AppError('not_found', 404, 'IMAP config not found');
      return reply.send({ config: c });
    } catch (e) { sendError(reply, e); }
  });

  app.delete('/api/imap-configs/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const ok = await deleteImapConfig(app.pool, ctx.tenantId, id);
      if (!ok) throw new AppError('not_found', 404, 'IMAP config not found');
      return reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });

  // Connect + open INBOX with the stored credential. Proves host/credential work
  // before the cron quietly fails; mirrors the SMTP test-send endpoint.
  app.post('/api/imap-configs/:id/test', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const cfg = await getImapConfigWithPassword(app.pool, app.cfg.encKey, id);
      if (!cfg || cfg.tenant_id !== ctx.tenantId) throw new AppError('not_found', 404, 'IMAP config not found');
      const session = await imapflowConnect({
        host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.username, pass: cfg.password,
      });
      try {
        return reply.send({ ok: true, uidValidity: session.uidValidity });
      } finally { await session.close(); }
    } catch (e) {
      sendError(reply, toImapTestError(e));
    }
  });
}

function toImapTestError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const err = e as { message?: string; authenticationFailed?: boolean; code?: string };
  let message: string;
  if (err.authenticationFailed) {
    message = 'Authentication rejected by IMAP server. For Microsoft 365 / Gmail this usually means an app password is required or IMAP access is disabled for the mailbox.';
  } else if (err.code === 'ENOTFOUND' || err.code === 'EDNS') {
    message = 'DNS lookup failed for IMAP host.';
  } else if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ECONNECTION') {
    message = 'Could not connect to IMAP server.';
  } else {
    message = err.message ?? 'IMAP test failed.';
  }
  return new AppError('imap_test_failed', 502, message);
}
