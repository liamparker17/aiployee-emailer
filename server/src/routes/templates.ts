import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { sendError, AppError } from '../util/errors.js';
import {
  createTemplate, updateTemplate, listTemplates, getTemplateById, deleteTemplate,
} from '../repos/templates.js';
import { render } from '../send/render.js';

const CreateBody = z.object({
  name: z.string().min(1).regex(/^[a-z0-9_-]+$/),
  subject: z.string().min(1),
  bodyHtml: z.string().min(1),
  bodyText: z.string().optional().nullable(),
});

const UpdateBody = z.object({
  name: z.string().min(1).regex(/^[a-z0-9_-]+$/).optional(),
  subject: z.string().min(1).optional(),
  bodyHtml: z.string().min(1).optional(),
  bodyText: z.string().nullable().optional(),
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
      reply.code(201).send({ template: t });
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
      reply.send({ template: t });
    } catch (e) { sendError(reply, e); }
  });

  app.delete('/api/templates/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const ok = await deleteTemplate(app.pool, ctx.tenantId, id);
      if (!ok) throw new AppError('not_found', 404, 'Template not found');
      reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/templates/:id/preview', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const body = PreviewBody.parse(req.body);
      const t = await getTemplateById(app.pool, ctx.tenantId, id);
      if (!t) throw new AppError('not_found', 404, 'Template not found');
      reply.send({
        subject: render(t.subject, body.variables, { escape: false }),
        html: render(t.body_html, body.variables),
        text: t.body_text ? render(t.body_text, body.variables, { escape: false }) : null,
      });
    } catch (e) { sendError(reply, new AppError('render_failed', 400, (e as Error).message)); }
  });
}
