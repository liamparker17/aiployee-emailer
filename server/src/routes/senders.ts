import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '@aiployee/core';
import { sendError, AppError } from '@aiployee/core';
import { createSender, listSenders, deleteSender, getSenderById } from '@aiployee/core';
import { getSmtpConfigWithPassword, resolveSmtpCreds, buildTransport } from '@aiployee/core';
import { sendViaGraph } from '@aiployee/core';
import { toSmtpTestError } from './smtpConfigs.js';

const CreateBody = z.object({
  email: z.string().email(),
  displayName: z.string().min(1),
  replyTo: z.string().email().optional().nullable(),
  smtpConfigId: z.string().uuid(),
  isDefault: z.boolean().default(false),
});

const TestBody = z.object({ to: z.string().email() });

export async function registerSenderRoutes(app: FastifyInstance) {
  app.get('/api/senders', async (req, reply) => {
    try { const ctx = requireTenantCtx(req); reply.send({ senders: await listSenders(app.pool, ctx.tenantId) }); }
    catch (e) { sendError(reply, e); }
  });

  app.post('/api/senders', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const body = CreateBody.parse(req.body);
      // verify smtp config belongs to tenant
      const r = await app.pool.query(
        `SELECT 1 FROM smtp_configs WHERE id = $1 AND tenant_id = $2`,
        [body.smtpConfigId, ctx.tenantId]);
      if (r.rowCount === 0) throw new AppError('invalid_smtp_config', 400, 'SMTP config not found in this tenant');
      const s = await createSender(app.pool, { tenantId: ctx.tenantId, ...body });
      return reply.code(201).send({ sender: s });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return sendError(reply, new AppError('email_taken', 409, 'Sender email already exists'));
      sendError(reply, e);
    }
  });

  app.post('/api/senders/:id/test', async (req, reply) => {
    let authType: 'password' | 'xoauth2' | 'graph' | undefined;
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const body = TestBody.parse(req.body);
      const sender = await getSenderById(app.pool, ctx.tenantId, id);
      if (!sender) throw new AppError('not_found', 404, 'Sender not found');
      const cfg = await getSmtpConfigWithPassword(app.pool, app.cfg.encKey, ctx.tenantId, sender.smtp_config_id);
      if (!cfg) throw new AppError('not_found', 404, 'SMTP config linked to this sender was not found');
      authType = cfg.auth_type;
      const creds = await resolveSmtpCreds(app.pool, app.cfg.encKey, cfg);
      if (creds.graphAccessToken) {
        const info = await sendViaGraph(creds.graphAccessToken, {
          from: sender.email,
          to: body.to,
          subject: 'Aiployee test (Graph)',
          text: 'If you can read this, sending from this address works (via Microsoft Graph).',
        });
        return reply.send({ ok: true, messageId: info.messageId, via: 'graph' });
      }
      const tx = buildTransport(creds);
      try {
        const info = await tx.sendMail({
          from: `${sender.display_name} <${sender.email}>`,
          to: body.to,
          subject: 'Aiployee test',
          text: 'If you can read this, sending from this address works.',
        });
        return reply.send({ ok: true, messageId: info.messageId, via: 'smtp' });
      } finally { tx.close(); }
    } catch (e) {
      sendError(reply, toSmtpTestError(e, authType));
    }
  });

  app.delete('/api/senders/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const ok = await deleteSender(app.pool, ctx.tenantId, id);
      if (!ok) throw new AppError('not_found', 404, 'Sender not found');
      return reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });
}
