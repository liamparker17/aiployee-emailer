import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '@aiployee/core';
import { sendError, AppError } from '@aiployee/core';
import { listContacts, createContact, updateContact, deleteContact, importContacts } from '../repos/contacts.js';
import { listLists, getList, createList, deleteList, addMembers, removeMember, listMembers } from '../repos/contactLists.js';

const attrs = z.record(z.string(), z.unknown());

export async function registerMarketingRoutes(app: FastifyInstance) {
  // ── Contacts ────────────────────────────────────────────────────────────────
  app.get('/api/contacts', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const q = z.object({ search: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }).parse(req.query);
      return reply.send({ contacts: await listContacts(app.pool, ctx.tenantId, q) });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/contacts', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const body = z.object({ email: z.string().email(), name: z.string().optional(), attributes: attrs.optional() }).parse(req.body);
      const contact = await createContact(app.pool, { tenantId: ctx.tenantId, ...body });
      return reply.code(201).send({ contact });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return sendError(reply, new AppError('contact_exists', 409, 'A contact with that email already exists'));
      sendError(reply, e);
    }
  });

  app.patch('/api/contacts/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const body = z.object({ name: z.string().nullable().optional(), attributes: attrs.optional(), subscribed: z.boolean().optional() }).parse(req.body);
      const contact = await updateContact(app.pool, ctx.tenantId, id, body);
      if (!contact) throw new AppError('not_found', 404, 'Contact not found');
      return reply.send({ contact });
    } catch (e) { sendError(reply, e); }
  });

  app.delete('/api/contacts/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const ok = await deleteContact(app.pool, ctx.tenantId, id);
      if (!ok) throw new AppError('not_found', 404, 'Contact not found');
      return reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/contacts/import', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const body = z.object({
        contacts: z.array(z.object({ email: z.string(), name: z.string().nullable().optional(), attributes: attrs.optional() })).max(5000),
      }).parse(req.body);
      return reply.send(await importContacts(app.pool, ctx.tenantId, body.contacts));
    } catch (e) { sendError(reply, e); }
  });

  // ── Lists ─────────────────────────────────────────────────────────────────────
  app.get('/api/lists', async (req, reply) => {
    try { const ctx = requireTenantCtx(req); return reply.send({ lists: await listLists(app.pool, ctx.tenantId) }); }
    catch (e) { sendError(reply, e); }
  });

  app.post('/api/lists', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const body = z.object({ name: z.string().min(1) }).parse(req.body);
      return reply.code(201).send({ list: await createList(app.pool, ctx.tenantId, body.name) });
    } catch (e) { sendError(reply, e); }
  });

  app.delete('/api/lists/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const ok = await deleteList(app.pool, ctx.tenantId, id);
      if (!ok) throw new AppError('not_found', 404, 'List not found');
      return reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/lists/:id/members', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const list = await getList(app.pool, ctx.tenantId, id);
      if (!list) throw new AppError('not_found', 404, 'List not found');
      return reply.send({ list, members: await listMembers(app.pool, ctx.tenantId, id) });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/lists/:id/members', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const body = z.object({ contactIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
      const added = await addMembers(app.pool, ctx.tenantId, id, body.contactIds);
      return reply.send({ added });
    } catch (e) { sendError(reply, e); }
  });

  app.delete('/api/lists/:id/members/:contactId', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id, contactId } = req.params as { id: string; contactId: string };
      const ok = await removeMember(app.pool, ctx.tenantId, id, contactId);
      if (!ok) throw new AppError('not_found', 404, 'Member not found');
      return reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });
}
