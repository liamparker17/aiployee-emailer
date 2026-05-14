import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { sendError, AppError } from '../util/errors.js';
import {
  createSmtpConfig, listSmtpConfigs, getSmtpConfigWithPassword, deleteSmtpConfig,
} from '../repos/smtpConfigs.js';
import { buildTransport } from '../send/sender.js';

const CreateBody = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean().default(false),
  username: z.string().min(1),
  password: z.string().min(1),
  fromDomain: z.string().min(1),
  isDefault: z.boolean().default(false),
});

const TestBody = z.object({ to: z.string().email() });

export async function registerSmtpConfigRoutes(app: FastifyInstance) {
  app.get('/api/smtp-configs', async (req, reply) => {
    try { const ctx = requireTenantCtx(req); reply.send({ configs: await listSmtpConfigs(app.pool, ctx.tenantId) }); }
    catch (e) { sendError(reply, e); }
  });

  app.post('/api/smtp-configs', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const body = CreateBody.parse(req.body);
      const c = await createSmtpConfig(app.pool, app.cfg.encKey, { tenantId: ctx.tenantId, ...body });
      reply.code(201).send({ config: c });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return sendError(reply, new AppError('name_taken', 409, 'Name already in use'));
      sendError(reply, e);
    }
  });

  app.delete('/api/smtp-configs/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const ok = await deleteSmtpConfig(app.pool, ctx.tenantId, id);
      if (!ok) throw new AppError('not_found', 404, 'SMTP config not found');
      reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/smtp-configs/:id/test', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const body = TestBody.parse(req.body);
      const cfg = await getSmtpConfigWithPassword(app.pool, app.cfg.encKey, ctx.tenantId, id);
      if (!cfg) throw new AppError('not_found', 404, 'SMTP config not found');
      const tx = buildTransport(cfg);
      try {
        const info = await tx.sendMail({
          from: `Aiployee Emailer <noreply@${cfg.from_domain}>`,
          to: body.to,
          subject: 'Aiployee Emailer SMTP test',
          text: 'If you can read this, your SMTP config works.',
        });
        reply.send({ ok: true, messageId: info.messageId });
      } finally { tx.close(); }
    } catch (e) {
      sendError(reply, new AppError('smtp_test_failed', 400, (e as Error).message));
    }
  });
}
