import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { sendError, AppError } from '../util/errors.js';
import { listCampaigns, getCampaign, createCampaign, setCampaignStatus, deleteCampaign, campaignStats } from '../repos/campaigns.js';
import { sendCampaign } from '../marketing/campaignSend.js';
import { verifyUnsubToken } from '../marketing/unsubscribe.js';
import { getContact, updateContact, importContacts, getContactIdsByEmails } from '../repos/contacts.js';
import { createList, addMembers } from '../repos/contactLists.js';
import { addSuppression } from '../repos/suppressions.js';

const attrs = z.record(z.string(), z.unknown());
const LaunchBody = z.object({
  name: z.string().min(1),
  listName: z.string().optional(),
  senderId: z.string().uuid(),
  subject: z.string().min(1),
  bodyHtml: z.string().min(1),
  contacts: z.array(z.object({ email: z.string(), name: z.string().nullable().optional(), attributes: attrs.optional() })).min(1).max(5000),
  scheduledFor: z.coerce.date().nullable().optional(),
});

const CreateBody = z.object({
  name: z.string().min(1),
  senderId: z.string().uuid(),
  subject: z.string().min(1),
  bodyHtml: z.string().min(1),
  templateId: z.string().uuid().nullable().optional(),
  audienceType: z.enum(['list', 'segment']),
  audienceId: z.string().uuid(),
  scheduledFor: z.coerce.date().nullable().optional(),
});

export async function registerCampaignRoutes(app: FastifyInstance) {
  app.get('/api/campaigns', async (req, reply) => {
    try { const ctx = requireTenantCtx(req); return reply.send({ campaigns: await listCampaigns(app.pool, ctx.tenantId) }); }
    catch (e) { sendError(reply, e); }
  });

  app.post('/api/campaigns', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const b = CreateBody.parse(req.body);
      const campaign = await createCampaign(app.pool, {
        tenantId: ctx.tenantId, name: b.name, senderId: b.senderId, subject: b.subject, bodyHtml: b.bodyHtml,
        templateId: b.templateId ?? null, audienceType: b.audienceType, audienceId: b.audienceId, scheduledFor: b.scheduledFor ?? null,
      });
      return reply.code(201).send({ campaign });
    } catch (e) { sendError(reply, e); }
  });

  // One-shot: import a CSV-derived contact list + custom template, then create & send.
  app.post('/api/campaigns/launch', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const b = LaunchBody.parse(req.body);
      const { imported } = await importContacts(app.pool, ctx.tenantId, b.contacts);
      const list = await createList(app.pool, ctx.tenantId, b.listName || `${b.name} recipients`);
      const ids = await getContactIdsByEmails(app.pool, ctx.tenantId, b.contacts.map(c => c.email));
      await addMembers(app.pool, ctx.tenantId, list.id, ids);
      const campaign = await createCampaign(app.pool, {
        tenantId: ctx.tenantId, name: b.name, senderId: b.senderId, subject: b.subject, bodyHtml: b.bodyHtml,
        templateId: null, audienceType: 'list', audienceId: list.id, scheduledFor: b.scheduledFor ?? null,
      });
      const result = await sendCampaign({ pool: app.pool, encKey: app.cfg.encKey, baseUrl: app.cfg.publicBaseUrl, tenantId: ctx.tenantId, campaignId: campaign.id });
      return reply.code(201).send({ campaignId: campaign.id, listId: list.id, imported, ...result });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/campaigns/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const campaign = await getCampaign(app.pool, ctx.tenantId, id);
      if (!campaign) throw new AppError('not_found', 404, 'Campaign not found');
      return reply.send({ campaign, stats: await campaignStats(app.pool, ctx.tenantId, id) });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/campaigns/:id/send', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const result = await sendCampaign({ pool: app.pool, encKey: app.cfg.encKey, baseUrl: app.cfg.publicBaseUrl, tenantId: ctx.tenantId, campaignId: id });
      return reply.send(result);
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/campaigns/:id/cancel', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const campaign = await getCampaign(app.pool, ctx.tenantId, id);
      if (!campaign) throw new AppError('not_found', 404, 'Campaign not found');
      // Cancel any of this campaign's still-queued emails, then mark the campaign canceled.
      await app.pool.query(`UPDATE emails SET status = 'canceled' WHERE tenant_id = $1 AND campaign_id = $2 AND status = 'queued'`, [ctx.tenantId, id]);
      await setCampaignStatus(app.pool, ctx.tenantId, id, 'canceled');
      return reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });

  app.delete('/api/campaigns/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const ok = await deleteCampaign(app.pool, ctx.tenantId, id);
      if (!ok) throw new AppError('not_found', 404, 'Campaign not found');
      return reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });

  // ── Public unsubscribe (auth-exempt; linked from campaign emails) ───────────────
  app.get('/v1/unsubscribe/:token', async (req, reply) => {
    const page = (msg: string) => `<!doctype html><html><body style="font-family:system-ui,sans-serif;text-align:center;padding:48px;color:#1a0f3d"><h2>${msg}</h2></body></html>`;
    try {
      const { token } = req.params as { token: string };
      const parsed = verifyUnsubToken(token, app.cfg.encKey);
      if (!parsed) return reply.code(400).type('text/html').send(page('Invalid unsubscribe link.'));
      const contact = await getContact(app.pool, parsed.tenantId, parsed.contactId);
      if (contact) {
        await updateContact(app.pool, parsed.tenantId, parsed.contactId, { subscribed: false });
        await addSuppression(app.pool, { tenantId: parsed.tenantId, address: contact.email, reason: 'manual' });
      }
      return reply.type('text/html').send(page("You've been unsubscribed. You won't receive further marketing emails."));
    } catch {
      return reply.type('text/html').send(page("You've been unsubscribed."));
    }
  });

  // One-click unsubscribe (RFC 8058 List-Unsubscribe-Post target). Mail clients POST here.
  app.post('/v1/unsubscribe/:token', async (req, reply) => {
    try {
      const { token } = req.params as { token: string };
      const parsed = verifyUnsubToken(token, app.cfg.encKey);
      if (!parsed) return reply.code(400).send({ ok: false });
      const contact = await getContact(app.pool, parsed.tenantId, parsed.contactId);
      if (contact) {
        await updateContact(app.pool, parsed.tenantId, parsed.contactId, { subscribed: false });
        await addSuppression(app.pool, { tenantId: parsed.tenantId, address: contact.email, reason: 'manual' });
      }
      return reply.send({ ok: true });
    } catch { return reply.send({ ok: true }); }
  });
}
