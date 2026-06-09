import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '@aiployee/core';
import { AppError, sendError } from '@aiployee/core';
import {
  createCampaign, getCampaign, listCampaigns, listRecipients,
  addRecipientsFromCsv, addRecipientsFromAudience,
  approveCampaign, pauseCampaign, resumeCampaign, cancelCampaign,
} from '../repos/callCampaigns.js';

function requireAdmin(ctx: ReturnType<typeof requireTenantCtx>): void {
  if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') {
    throw new AppError('forbidden', 403, 'Admin role required');
  }
}

async function loadCampaignOr404(app: FastifyInstance, tenantId: string, id: string) {
  const c = await getCampaign(app.pool, tenantId, id);
  if (!c) throw new AppError('not_found', 404, 'Campaign not found');
  return c;
}

export function registerCallCampaignRoutes(app: FastifyInstance): void {
  app.post('/api/calls/campaigns', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const b = z.object({
        agent_id: z.string().uuid(),
        name: z.string().min(1).max(160),
        audience_type: z.enum(['list', 'segment', 'csv']),
        audience_id: z.string().uuid().optional(),
        scheduled_for: z.string().datetime().optional(),
      }).parse(req.body);
      if ((b.audience_type === 'list' || b.audience_type === 'segment') && !b.audience_id) {
        throw new AppError('bad_request', 400, 'audience_id required for list/segment campaigns');
      }
      const c = await createCampaign(app.pool, {
        tenantId: ctx.tenantId, agentId: b.agent_id, name: b.name,
        audienceType: b.audience_type, audienceId: b.audience_id ?? null,
        scheduledFor: b.scheduled_for ? new Date(b.scheduled_for) : null, createdBy: ctx.userId,
      });
      reply.code(201).send({ campaign: c });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/calls/campaigns/:id/recipients', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const id = (req.params as { id: string }).id;
      const c = await loadCampaignOr404(app, ctx.tenantId, id);
      if (c.status !== 'draft') throw new AppError('invalid_state', 400, 'Recipients can only be added while draft');
      const b = z.discriminatedUnion('source', [
        z.object({ source: z.literal('csv'), rows: z.array(z.record(z.string())).min(1).max(10000) }),
        z.object({ source: z.literal('audience') }),
      ]).parse(req.body);
      if (b.source === 'audience' && (c.audience_type === 'csv' || !c.audience_id)) {
        throw new AppError('bad_request', 400, 'Campaign has no stored audience; upload CSV rows instead');
      }
      const result = b.source === 'csv'
        ? await addRecipientsFromCsv(app.pool, { tenantId: ctx.tenantId, campaignId: id, agentId: c.agent_id, rows: b.rows })
        : await addRecipientsFromAudience(app.pool, { tenantId: ctx.tenantId, campaignId: id, agentId: c.agent_id,
            audienceType: c.audience_type as 'list' | 'segment', audienceId: c.audience_id as string });
      reply.send(result);
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/calls/campaigns', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      reply.send({ campaigns: await listCampaigns(app.pool, ctx.tenantId) });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/calls/campaigns/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      reply.send({ campaign: await loadCampaignOr404(app, ctx.tenantId, (req.params as { id: string }).id) });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/calls/campaigns/:id/recipients', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req); requireAdmin(ctx);
      const id = (req.params as { id: string }).id;
      await loadCampaignOr404(app, ctx.tenantId, id);
      const q = z.object({
        status: z.enum(['pending','queued','launched','failed','suppressed','completed','canceled']).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      }).parse(req.query);
      reply.send(await listRecipients(app.pool, ctx.tenantId, id, q));
    } catch (e) { sendError(reply, e); }
  });

  const action = (path: string, fn: (tenantId: string, id: string, userId?: string) => Promise<unknown>) =>
    app.post(`/api/calls/campaigns/:id/${path}`, async (req, reply) => {
      try {
        const ctx = requireTenantCtx(req); requireAdmin(ctx);
        const id = (req.params as { id: string }).id;
        reply.send({ campaign: await fn(ctx.tenantId, id, ctx.userId) });
      } catch (e) { sendError(reply, e); }
    });

  action('approve', (tid, id, uid) => approveCampaign(app.pool, tid, id, uid ?? null));
  action('pause',   (tid, id) => pauseCampaign(app.pool, tid, id));
  action('resume',  (tid, id) => resumeCampaign(app.pool, tid, id));
  action('cancel',  (tid, id) => cancelCampaign(app.pool, tid, id));
}
