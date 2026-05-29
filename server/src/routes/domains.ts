import { resolveTxt } from 'node:dns/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { sendError, AppError } from '../util/errors.js';
import {
  listSendingDomains,
  createSendingDomain,
  getSendingDomain,
  setDomainVerification,
  deleteSendingDomain,
} from '../repos/sendingDomains.js';

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

const CreateBody = z.object({
  domain: z
    .string()
    .min(1)
    .transform(v => v.trim().toLowerCase())
    .refine(v => DOMAIN_RE.test(v), { message: 'Invalid domain name' }),
});

export async function registerDomainRoutes(app: FastifyInstance) {
  app.get('/api/domains', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const domains = await listSendingDomains(app.pool, ctx.tenantId);
      reply.send({ domains });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/domains', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { domain } = CreateBody.parse(req.body);
      const created = await createSendingDomain(app.pool, { tenantId: ctx.tenantId, domain });
      return reply.code(201).send({ domain: created });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        return sendError(reply, new AppError('domain_exists', 409, 'This domain is already registered for your account'));
      }
      sendError(reply, e);
    }
  });

  app.delete('/api/domains/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const ok = await deleteSendingDomain(app.pool, ctx.tenantId, id);
      if (!ok) throw new AppError('not_found', 404, 'Domain not found');
      reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/domains/:id/verify', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const row = await getSendingDomain(app.pool, ctx.tenantId, id);
      if (!row) throw new AppError('not_found', 404, 'Domain not found');

      // Check SPF: look for a TXT record starting with 'v=spf1'
      let spfOk = false;
      try {
        const records = await resolveTxt(row.domain);
        spfOk = records.some(parts => parts.join('').startsWith('v=spf1'));
      } catch (_) { /* ENODATA / ENOTFOUND → spfOk stays false */ }

      // Check DMARC: look for a TXT record at _dmarc.<domain> containing 'v=DMARC1'
      let dmarcOk = false;
      try {
        const records = await resolveTxt(`_dmarc.${row.domain}`);
        dmarcOk = records.some(parts => parts.join('').includes('v=DMARC1'));
      } catch (_) { /* ENODATA / ENOTFOUND → dmarcOk stays false */ }

      const updated = await setDomainVerification(app.pool, ctx.tenantId, id, { spfOk, dmarcOk });
      reply.send({ domain: updated });
    } catch (e) { sendError(reply, e); }
  });
}
