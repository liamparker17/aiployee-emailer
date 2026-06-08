import type { FastifyInstance } from 'fastify';
import { sendError, AppError } from '@aiployee/core';
import { verifySnsMessage, parseSesNotification } from '../webhooks/ses.js';
import { verifyMailgun, parseMailgunEvent } from '../webhooks/mailgun.js';
import { findByMessageId, markStatus } from '../repos/emails.js';
import { addSuppression } from '@aiployee/core';
import { deliverEmailEvent } from '../webhooks/eventDelivery.js';

export async function registerV1WebhookRoutes(app: FastifyInstance) {
  app.post('/v1/webhooks/bounce/ses', async (req, reply) => {
    try {
      const body = req.body as Record<string, string>;
      await verifySnsMessage(body as never);
      if (body.Type === 'SubscriptionConfirmation' && body.SubscribeURL) {
        // Auto-confirm by GETing SubscribeURL out-of-band; logged so operator sees it.
        req.log.info({ url: body.SubscribeURL }, 'SNS subscription confirmation received');
        return reply.send({ ok: true, confirm: body.SubscribeURL });
      }
      const ev = parseSesNotification(body.Message);
      if (!ev) return reply.send({ ok: true, ignored: true });
      const email = await findByMessageId(app.pool, ev.messageId);
      if (!email) return reply.send({ ok: true, unknown: true });
      if (ev.type === 'bounce' || ev.type === 'complaint') {
        await markStatus(app.pool, email.id, ev.type === 'bounce' ? 'bounced' : 'complained');
        for (const r of ev.recipients) {
          await addSuppression(app.pool, { tenantId: email.tenant_id, address: r, reason: ev.type });
        }
        await deliverEmailEvent({ pool: app.pool, encKey: app.cfg.encKey, tenantId: email.tenant_id, event: ev.type === 'bounce' ? 'bounced' : 'complained', payload: { email_id: email.id } });
      }
      return reply.send({ ok: true });
    } catch (e) { sendError(reply, new AppError('webhook_failed', 400, (e as Error).message)); }
  });

  app.post('/v1/webhooks/bounce/mailgun', async (req, reply) => {
    try {
      const body = req.body as Record<string, unknown>;
      verifyMailgun(body as never, app.cfg);
      const ev = parseMailgunEvent(body as never);
      if (!ev) return reply.send({ ok: true, ignored: true });
      const email = await findByMessageId(app.pool, ev.messageId);
      if (!email) return reply.send({ ok: true, unknown: true });
      if (ev.type === 'bounce' || ev.type === 'complaint') {
        await markStatus(app.pool, email.id, ev.type === 'bounce' ? 'bounced' : 'complained');
        await addSuppression(app.pool, { tenantId: email.tenant_id, address: ev.recipient, reason: ev.type });
        await deliverEmailEvent({ pool: app.pool, encKey: app.cfg.encKey, tenantId: email.tenant_id, event: ev.type === 'bounce' ? 'bounced' : 'complained', payload: { email_id: email.id } });
      }
      return reply.send({ ok: true });
    } catch (e) { sendError(reply, new AppError('webhook_failed', 400, (e as Error).message)); }
  });
}
