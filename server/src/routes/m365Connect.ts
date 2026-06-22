import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '@aiployee/core';
import { sendError, AppError } from '@aiployee/core';
import {
  startDeviceCode, pollDeviceCode,
  M365_FULL_SCOPE, DEFAULT_MS_CLIENT_ID, DEFAULT_MS_TENANT,
} from '@aiployee/core';
import { createM365Connection } from '@aiployee/core';

const StartBody = z.object({
  username: z.string().min(3),
});

const CompleteBody = z.object({
  deviceCode: z.string().min(1),
  username: z.string().min(3),
  name: z.string().min(1),
  fromDomain: z.string().min(1),
  displayName: z.string().optional(),
  isDefault: z.boolean().default(false),
});

export async function registerM365ConnectRoutes(app: FastifyInstance) {
  // Start a device-code flow that requests BOTH IMAP + SMTP scopes in one consent.
  // The user visits the returned verificationUri, enters userCode, and signs in.
  app.post('/api/m365/connect/start', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      void ctx; // tenant auth check — ctx unused beyond guard
      const body = StartBody.parse(req.body);
      const dc = await startDeviceCode({ scope: M365_FULL_SCOPE }).catch((e: Error) => {
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

  // Poll once: if sign-in is complete, create SMTP config + sender + IMAP config atomically.
  app.post('/api/m365/connect/complete', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const body = CompleteBody.parse(req.body);
      const res = await pollDeviceCode({ deviceCode: body.deviceCode });
      if (res.status === 'pending') return reply.code(202).send({ pending: true });
      if (res.status === 'failed') throw new AppError('oauth_failed', 400, res.error);
      if (!res.tokens.refreshToken) {
        throw new AppError('oauth_failed', 400, 'Microsoft did not return a refresh token (offline_access missing?)');
      }
      const result = await createM365Connection(app.pool, app.cfg.encKey, {
        tenantId: ctx.tenantId,
        username: body.username,
        name: body.name,
        fromDomain: body.fromDomain,
        displayName: body.displayName,
        isDefault: body.isDefault,
        clientId: DEFAULT_MS_CLIENT_ID,
        oauthTenant: DEFAULT_MS_TENANT,
        refreshToken: res.tokens.refreshToken,
      });
      return reply.code(201).send(result);
    } catch (e) { sendError(reply, e); }
  });
}
