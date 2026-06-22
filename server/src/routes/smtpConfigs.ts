import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '@aiployee/core';
import { sendError, AppError } from '@aiployee/core';
import {
  createSmtpConfig, createSmtpConfigOauth, listSmtpConfigs, getSmtpConfigWithPassword, deleteSmtpConfig,
} from '@aiployee/core';
import { buildTransport, resolveSmtpCreds, getSenderForSmtpConfig } from '@aiployee/core';
import {
  startDeviceCode, pollDeviceCode,
  SMTP_SCOPE, DEFAULT_MS_CLIENT_ID, DEFAULT_MS_TENANT,
} from '@aiployee/core';

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

const OauthStartBody = z.object({ username: z.string().min(3) });

const OauthCompleteBody = z.object({
  deviceCode: z.string().min(1),
  username: z.string().min(3),
  name: z.string().min(1),
  fromDomain: z.string().min(1),
  host: z.string().min(1).default('smtp.office365.com'),
  port: z.number().int().default(587),
  secure: z.boolean().default(false),
  isDefault: z.boolean().default(false),
});

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
    let authType: 'password' | 'xoauth2' | undefined;
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const body = TestBody.parse(req.body);
      const cfg = await getSmtpConfigWithPassword(app.pool, app.cfg.encKey, ctx.tenantId, id);
      if (!cfg) throw new AppError('not_found', 404, 'SMTP config not found');
      authType = cfg.auth_type as 'password' | 'xoauth2' | undefined;
      const creds = await resolveSmtpCreds(app.pool, app.cfg.encKey, cfg);
      const tx = buildTransport(creds);
      // Prefer the sender identity linked to this config: relay providers (Mimecast,
      // SES) authenticate as a service account that is NOT the From address. Gmail/
      // Outlook ignore or reject a mismatched From, so falling back to the username
      // keeps the old behavior when no sender is linked.
      const sender = await getSenderForSmtpConfig(app.pool, ctx.tenantId, id);
      const fromAddr = sender?.email ?? cfg.username;
      const fromName = sender?.display_name ?? 'Aiployee Emailer';
      try {
        const info = await tx.sendMail({
          from: `${fromName} <${fromAddr}>`,
          to: body.to,
          subject: 'Aiployee Emailer SMTP test',
          text: 'If you can read this, your SMTP config works.',
        });
        return reply.send({ ok: true, messageId: info.messageId });
      } finally { tx.close(); }
    } catch (e) {
      sendError(reply, toSmtpTestError(e, authType));
    }
  });

  app.post('/api/smtp-configs/oauth/start', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const body = OauthStartBody.parse(req.body);
      const dc = await startDeviceCode({ scope: SMTP_SCOPE }).catch((e: Error) => {
        throw new AppError('oauth_start_failed', 502, e.message);
      });
      return reply.send({
        username: body.username,
        userCode: dc.userCode,
        verificationUri: dc.verificationUri,
        deviceCode: dc.deviceCode,
        intervalSeconds: dc.intervalSeconds,
        expiresInSeconds: dc.expiresInSeconds,
      });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/smtp-configs/oauth/complete', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const body = OauthCompleteBody.parse(req.body);
      const res = await pollDeviceCode({ deviceCode: body.deviceCode });
      if (res.status === 'pending') return reply.code(202).send({ pending: true });
      if (res.status === 'failed') throw new AppError('oauth_failed', 400, res.error);
      if (!res.tokens.refreshToken) throw new AppError('oauth_failed', 400, 'Microsoft did not return a refresh token (offline_access missing?)');
      const config = await createSmtpConfigOauth(app.pool, app.cfg.encKey, {
        tenantId: ctx.tenantId, name: body.name, host: body.host, port: body.port,
        secure: body.secure, username: body.username, fromDomain: body.fromDomain,
        isDefault: body.isDefault, clientId: DEFAULT_MS_CLIENT_ID,
        oauthTenant: DEFAULT_MS_TENANT, refreshToken: res.tokens.refreshToken,
      });
      return reply.code(201).send({ config });
    } catch (e) { sendError(reply, e); }
  });
}

// Nodemailer errors carry structured fields (code, responseCode, response, command)
// that are useful for diagnosis. Extract them and produce a friendly summary + details.
// See: https://nodemailer.com/usage/#errors
function toSmtpTestError(e: unknown, authType?: 'password' | 'xoauth2'): AppError {
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
  const rawResponse = smtpResponse ?? err.message;

  // Auth-method prefix so the user knows which path ran.
  const authPrefix = authType === 'xoauth2'
    ? 'Authenticated via Microsoft OAuth.'
    : authType === 'password'
      ? 'Authenticated with username + password.'
      : '';

  let baseMessage: string;
  if (nmCode === 'EAUTH' || smtpCode === 535) {
    baseMessage = 'Authentication rejected by SMTP server.';
  } else if (nmCode === 'ECONNECTION' || nmCode === 'ESOCKET') {
    baseMessage = 'Could not connect to SMTP server.';
  } else if (nmCode === 'ETIMEDOUT') {
    baseMessage = 'Connection timed out.';
  } else if (nmCode === 'EDNS') {
    baseMessage = 'DNS lookup failed for SMTP host.';
  } else if (nmCode === 'EENVELOPE') {
    baseMessage = 'SMTP server rejected the sender or recipient address.';
  } else {
    baseMessage = err.message ?? 'SMTP test failed.';
  }

  // Append the raw server response so the user can see exactly what Microsoft/Gmail said.
  const serverSaid = rawResponse && rawResponse !== baseMessage
    ? ` Server said: "${rawResponse}"`
    : '';

  // Actionable hints keyed on well-known substrings in the raw response.
  let hint: string | undefined;
  const resp = (rawResponse ?? '').toLowerCase();

  if (resp.includes('smtpclientauthentication is disabled')) {
    hint = 'Microsoft has "Authenticated SMTP" turned OFF for this mailbox. SMTP send is blocked even with OAuth until an admin enables it (Exchange admin center → this user → Mail → Manage email apps → tick "Authenticated SMTP"), or this mailbox must use Microsoft Graph send instead.';
  } else if (resp.includes('tenantattribution') || (resp.includes('tenant') && resp.includes('disabled'))) {
    hint = 'Authenticated SMTP is disabled for the whole tenant — an admin must enable it (Set-TransportConfig -SmtpClientAuthenticationDisabled $false).';
  } else if (resp.includes('must issue a starttls')) {
    hint = 'Wrong TLS setting — use port 587 with TLS/secure OFF (STARTTLS).';
  } else if (
    resp.includes('invalid login') ||
    resp.includes('username and password not accepted') ||
    resp.includes('badcredentials')
  ) {
    if (authType === 'xoauth2') {
      hint = 'The OAuth token was rejected — reconnect the mailbox (the consent may not include the sending scope).';
    } else {
      hint = "Gmail rejected the login. Make sure 2-step verification is enabled and you're using a 16-character App Password (without spaces). Also confirm the from-address matches the authenticated user.";
    }
  } else if (smtpCode === 535 || resp.includes('badcredentials')) {
    if (authType !== 'xoauth2') {
      hint = "Gmail rejected the login. Make sure 2-step verification is enabled and you're using a 16-character App Password (without spaces). Also confirm the from-address matches the authenticated user.";
    }
  }

  const parts = [authPrefix, baseMessage + serverSaid, hint].filter(Boolean);
  const message = parts.join(' ');

  const details = { smtpCode, smtpResponse, command, hint };
  return new AppError(nmCode ?? 'smtp_test_failed', 400, message, details);
}
