import type { FastifyInstance } from 'fastify';
import { requireTenantCtx } from '../auth/ctx.js';
import { sendError } from '@aiployee/core';
import { engagementSummary } from '../repos/emailEvents.js';

export async function registerAnalyticsRoutes(app: FastifyInstance) {
  app.get('/api/analytics/summary', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      reply.send({ summary: await engagementSummary(app.pool, ctx.tenantId) });
    } catch (e) { sendError(reply, e); }
  });
}
