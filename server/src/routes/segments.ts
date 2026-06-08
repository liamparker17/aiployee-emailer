import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '@aiployee/core';
import { sendError, AppError } from '@aiployee/core';
import {
  listSegments,
  getSegment,
  createSegment,
  deleteSegment,
  previewSegment,
} from '@aiployee/core';
import type { SegmentFilter } from '@aiployee/core';

const ruleSchema = z.object({
  field: z.string().min(1),
  cmp: z.enum(['eq', 'neq', 'contains', 'exists', 'gt', 'lt']),
  value: z.string().optional(),
});

const filterSchema = z.object({
  op: z.enum(['and', 'or']),
  rules: z.array(ruleSchema),
});

export async function registerSegmentRoutes(app: FastifyInstance) {
  // GET /api/segments — list all saved segments for the tenant
  app.get('/api/segments', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const segments = await listSegments(app.pool, ctx.tenantId);
      return reply.send({ segments });
    } catch (e) { sendError(reply, e); }
  });

  // POST /api/segments — create a new saved segment
  app.post('/api/segments', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const body = z.object({
        name: z.string().min(1),
        filter: filterSchema,
      }).parse(req.body);
      const segment = await createSegment(app.pool, ctx.tenantId, body.name, body.filter as SegmentFilter);
      return reply.code(201).send({ segment });
    } catch (e) { sendError(reply, e); }
  });

  // DELETE /api/segments/:id — delete a saved segment
  app.delete('/api/segments/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const ok = await deleteSegment(app.pool, ctx.tenantId, id);
      if (!ok) throw new AppError('not_found', 404, 'Segment not found');
      return reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });

  // POST /api/segments/preview — preview an unsaved filter
  app.post('/api/segments/preview', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const body = z.object({ filter: filterSchema }).parse(req.body);
      const result = await previewSegment(app.pool, ctx.tenantId, body.filter as SegmentFilter);
      return reply.send(result);
    } catch (e) { sendError(reply, e); }
  });

  // GET /api/segments/:id/preview — preview a saved segment's filter
  app.get('/api/segments/:id/preview', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const segment = await getSegment(app.pool, ctx.tenantId, id);
      if (!segment) throw new AppError('not_found', 404, 'Segment not found');
      const result = await previewSegment(app.pool, ctx.tenantId, segment.filter);
      return reply.send(result);
    } catch (e) { sendError(reply, e); }
  });
}
