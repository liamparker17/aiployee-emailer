import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sendError, AppError } from '@aiployee/core';
import { requireCtx } from '../auth/ctx.js';
import { ingestJobixCall } from '../agent/abe/ingestCall.js';
import { getLineReportConfig } from '../repos/lineReportConfigs.js';
import type { AttributionMap } from '../agent/abe/jobixPayload.js';
import { linkResultBySuid } from '../repos/callCampaigns.js';

// Lenient: Jobix shapes vary per tenant. We accept any object and let normalizeCall sort it out.
const Body = z.record(z.unknown());

// Derive a stable idempotency ref from the payload: prefer an explicit call id, else suid+timestamp.
function callRef(b: Record<string, unknown>): string {
  const cd = (b.customer_data ?? {}) as Record<string, unknown>;
  const main = (cd.main ?? {}) as Record<string, unknown>;
  const suid = (main.suid ?? b.suid ?? '') as string;
  const explicit = (b.call_id ?? b.call_ref ?? b.id) as string | undefined;
  if (explicit) return String(explicit);
  const ts = (b.timestamp ?? b.call_time ?? b.created_at ?? '') as string;
  return ts ? `${suid}:${ts}` : `${suid}`;
}

export async function registerV1JobixRoutes(app: FastifyInstance) {
  app.post('/v1/jobix/calls', { bodyLimit: 262144 }, async (req, reply) => {
    try {
      const ctx = requireCtx(req);
      if (ctx.role !== 'api_key') throw new AppError('unauthorized', 401, 'API key required');
      const b = Body.parse(req.body ?? {});
      const ref = callRef(b);
      if (!ref || ref === ':') throw new AppError('bad_request', 400, 'Cannot derive a call reference (need suid or call id)');

      const cfg = await getLineReportConfig(app.pool, ctx.tenantId);
      const attribution = (cfg?.attribution_map ?? {}) as AttributionMap;

      const out = await ingestJobixCall({
        pool: app.pool, tenantId: ctx.tenantId, callRef: ref, body: b, attribution,
        lineRef: (b.company_key as string | undefined) ?? null,
      });

      const cd = (b.customer_data ?? {}) as Record<string, unknown>;
      const main = (cd.main ?? {}) as Record<string, unknown>;
      const suid = String((main.suid ?? b.suid ?? '') || '');
      const outcome = (b.call_outcome ?? b.outcome ?? null) as string | null;
      if (suid) {
        await linkResultBySuid(app.pool, ctx.tenantId, suid, out.messageId, outcome);
      }

      return reply.code(202).send({ created: out.created, message_id: out.messageId });
    } catch (e) { sendError(reply, e); }
  });
}
