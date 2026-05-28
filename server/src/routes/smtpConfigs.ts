import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { sendError, AppError } from '../util/errors.js';
import {
  createSmtpConfig, listSmtpConfigs, getSmtpConfigWithPassword, deleteSmtpConfig,
} from '../repos/smtpConfigs.js';
import { buildTransport } from '../send/sender.js';

const CreateBody = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean().default(false),
  username: z.string().min(1),
  password: z.string().min(1),
  fromDomain: z.string().min(1),
  isDefault: z.boolean().default(false),
});

const TestBody = z.object({ to: z.string().email() });

export async function registerSmtpConfigRoutes(app: FastifyInstance) {
  app.get('/api/smtp-configs', async (req, reply) => {
    try { const ctx = requireTenantCtx(req); reply.send({ configs: await listSmtpConfigs(app.pool, ctx.tenantId) }); }
    catch (e) { sendError(reply, e); }
  });

  app.post('/api/smtp-configs', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const parsed = CreateBody.parse(req.body);
      // Gmail app passwords are displayed as `xxxx xxxx xxxx xxxx`; users commonly paste verbatim.
      // SMTP servers reject the whitespace form. Strip ALL whitespace before persisting.
      const body = { ...parsed, password: parsed.password.replace(/\s+/g, '') };
      const c = await createSmtpConfig(app.pool, app.cfg.encKey, { tenantId: ctx.tenantId, ...body });
      return reply.code(201).send({ config: c });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return sendError(reply, new AppError('name_taken', 409, 'Name already in use'));
      sendError(reply, e);
    }
  });

  app.delete('/api/smtp-configs/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const ok = await deleteSmtpConfig(app.pool, ctx.tenantId, id);
      if (!ok) throw new AppError('not_found', 404, 'SMTP config not found');
      return reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/smtp-configs/:id/test', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const body = TestBody.parse(req.body);
      const cfg = await getSmtpConfigWithPassword(app.pool, app.cfg.encKey, ctx.tenantId, id);
      if (!cfg) throw new AppError('not_found', 404, 'SMTP config not found');
      const tx = buildTransport(cfg);
      try {
        const info = await tx.sendMail({
          // Use the authenticated SMTP user as the From: address. Gmail (and most SMTP relays)
          // reject submissions where From: doesn't belong to the authenticated user. For non-Gmail
          // providers where `username` may not be an email (e.g. SES IAM-style usernames), this
          // could need adjustment — but for Gmail/Outlook/most providers, username IS the email.
          from: `Aiployee Emailer <${cfg.username}>`,
          to: body.to,
          subject: 'Aiployee Emailer SMTP test',
          text: 'If you can read this, your SMTP config works.',
        });
        return reply.send({ ok: true, messageId: info.messageId });
      } finally { tx.close(); }
    } catch (e) {
      sendError(reply, toSmtpTestError(e));
    }
  });
}

// Nodemailer errors carry structured fields (code, responseCode, response, command)
// that are useful for diagnosis. Extract them and produce a friendly summary + details.
// See: https://nodemailer.com/usage/#errors
function toSmtpTestError(e: unknown): AppError {
  const err = e as {
    message?: string;
    code?: string;
    responseCode?: number;
    response?: string;
    command?: string;
  };
  const smtpCode = typeof err.responseCode === 'number' ? err.responseCode : undefined;
  const smtpResponse = typeof err.response === 'string' ? err.response : undefined;
  const command = typeof err.command === 'string' ? err.command : undefined;
  const nmCode = typeof err.code === 'string' ? err.code : undefined;

  let message: string;
  if (nmCode === 'EAUTH' || smtpCode === 535) {
    message = 'Authentication rejected by SMTP server.';
  } else if (nmCode === 'ECONNECTION' || nmCode === 'ESOCKET') {
    message = 'Could not connect to SMTP server.';
  } else if (nmCode === 'ETIMEDOUT') {
    message = 'Connection timed out.';
  } else if (nmCode === 'EDNS') {
    message = 'DNS lookup failed for SMTP host.';
  } else if (nmCode === 'EENVELOPE') {
    message = 'SMTP server rejected the sender or recipient address.';
  } else {
    message = err.message ?? 'SMTP test failed.';
  }

  let hint: string | undefined;
  if (smtpCode === 535 || (smtpResponse && smtpResponse.includes('BadCredentials'))) {
    hint = "Gmail rejected the login. Make sure 2-step verification is enabled and you're using a 16-character App Password (without spaces). Also confirm the from-address matches the authenticated user.";
  }

  const details = { smtpCode, smtpResponse, command, hint };
  return new AppError(nmCode ?? 'smtp_test_failed', 400, message, details);
}
