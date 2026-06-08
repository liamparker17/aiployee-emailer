import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '@aiployee/core';
import { sendError, AppError } from '@aiployee/core';
import {
  createTemplate, updateTemplate, listTemplates, getTemplateById, deleteTemplate,
} from '../repos/templates.js';
import { render } from '../send/render.js';
import { getDefaultSender } from '../repos/senders.js';
import { insertEmail } from '../repos/emails.js';
import { dispatchEmail } from '../send/dispatch.js';

function requireAdmin(ctx: ReturnType<typeof requireTenantCtx>): void {
  if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') {
    throw new AppError('forbidden', 403, 'Admin role required');
  }
}

const CreateBody = z.object({
  name: z.string().min(1).regex(/^[a-z0-9_-]+$/),
  subject: z.string().min(1),
  bodyHtml: z.string().min(1),
  bodyText: z.string().optional().nullable(),
  displayName: z.string().max(120).trim().nullable().optional(),
});

const UpdateBody = z.object({
  name: z.string().min(1).regex(/^[a-z0-9_-]+$/).optional(),
  subject: z.string().min(1).optional(),
  bodyHtml: z.string().min(1).optional(),
  bodyText: z.string().nullable().optional(),
  displayName: z.string().max(120).trim().nullable().optional(),
});

const PreviewBody = z.object({ variables: z.record(z.string(), z.string()) });

export async function registerTemplateRoutes(app: FastifyInstance) {
  app.get('/api/templates', async (req, reply) => {
    try { const ctx = requireTenantCtx(req); reply.send({ templates: await listTemplates(app.pool, ctx.tenantId) }); }
    catch (e) { sendError(reply, e); }
  });

  app.post('/api/templates', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const body = CreateBody.parse(req.body);
      const t = await createTemplate(app.pool, { tenantId: ctx.tenantId, ...body });
      return reply.code(201).send({ template: t });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return sendError(reply, new AppError('name_taken', 409, 'Template name already exists'));
      sendError(reply, e);
    }
  });

  app.patch('/api/templates/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const body = UpdateBody.parse(req.body);
      const { id } = req.params as { id: string };
      const t = await updateTemplate(app.pool, ctx.tenantId, id, body);
      if (!t) throw new AppError('not_found', 404, 'Template not found');
      return reply.send({ template: t });
    } catch (e) { sendError(reply, e); }
  });

  app.delete('/api/templates/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const ok = await deleteTemplate(app.pool, ctx.tenantId, id);
      if (!ok) throw new AppError('not_found', 404, 'Template not found');
      return reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/templates/:id/preview', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const body = PreviewBody.parse(req.body);
      const t = await getTemplateById(app.pool, ctx.tenantId, id);
      if (!t) throw new AppError('not_found', 404, 'Template not found');
      return reply.send({
        subject: render(t.subject, body.variables, { escape: false }),
        html: render(t.body_html, body.variables),
        text: t.body_text ? render(t.body_text, body.variables, { escape: false }) : null,
      });
    } catch (e) { sendError(reply, new AppError('render_failed', 400, (e as Error).message)); }
  });

  app.post('/api/templates/:id/test-send', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const { id } = req.params as { id: string };
      const body = z.object({
        to: z.string().email(),
        variables: z.record(z.string(), z.string()).optional(),
      }).parse(req.body);
      const tpl = await getTemplateById(app.pool, ctx.tenantId, id);
      if (!tpl) throw new AppError('not_found', 404, 'Template not found');
      const sender = await getDefaultSender(app.pool, ctx.tenantId);
      if (!sender) throw new AppError('no_sender', 400, 'No default sender configured — add a sender first.');
      const vars: Record<string, string> = {};
      for (const name of tpl.variables ?? []) vars[name] = body.variables?.[name] ?? name;
      if (body.variables) for (const [k, v] of Object.entries(body.variables)) vars[k] = v;
      const email = await insertEmail(app.pool, {
        tenantId: ctx.tenantId, senderId: sender.id, toAddr: body.to,
        subject: render(tpl.subject, vars, { escape: false }),
        bodyHtml: render(tpl.body_html, vars),
        bodyText: tpl.body_text ? render(tpl.body_text, vars, { escape: false }) : null,
        templateId: tpl.id, fromDisplayName: tpl.display_name?.trim() || null, status: 'queued',
      });
      const outcome = await dispatchEmail({
        pool: app.pool, encKey: app.cfg.encKey, email, baseUrl: app.cfg.publicBaseUrl,
      });
      if (outcome.ok) reply.send({ ok: true, messageId: outcome.messageId });
      else reply.send({ ok: false, error: outcome.error });
    } catch (e) { sendError(reply, e); }
  });
}
