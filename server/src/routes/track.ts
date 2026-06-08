import type { FastifyInstance } from 'fastify';
import { recordOpen, recordClick } from '../repos/emailEvents.js';
import { TRACKING_PIXEL } from '@aiployee/core';

// Public (no auth) — these URLs are embedded in sent emails and hit by recipients.
export async function registerTrackRoutes(app: FastifyInstance) {
  app.get('/v1/track/open/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try { await recordOpen(app.pool, id); } catch { /* a tracking failure must never break the pixel */ }
    return reply
      .header('Content-Type', 'image/gif')
      .header('Cache-Control', 'no-store, max-age=0')
      .send(TRACKING_PIXEL);
  });

  app.get('/v1/track/click/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const u = (req.query as { u?: string }).u ?? '';
    try { await recordClick(app.pool, id, u); } catch { /* ignore */ }
    // Open-redirect guard: only follow http(s); anything else falls back to the app.
    const target = /^https?:\/\//i.test(u) ? u : app.cfg.publicBaseUrl;
    return reply.redirect(target);
  });
}
