import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { logger } from '@aiployee/core';
import { loadConfig, type Config } from '@aiployee/core';
import { getPool } from '@aiployee/core';
import { registerSessions } from '@aiployee/core';
import { registerHandoffRoutes } from '@aiployee/core';
import { registerCsrf } from '@aiployee/core';
import { registerCtx } from '@aiployee/core';
import { registerAuthRoutes } from '@aiployee/core';
import { registerAdminTenantRoutes } from '@aiployee/core';
import { registerSmtpConfigRoutes } from './routes/smtpConfigs.js';
import { registerSenderRoutes } from './routes/senders.js';
import { registerTemplateRoutes } from './routes/templates.js';
import { registerApiKeyRoutes } from '@aiployee/core';
import { registerV1EmailRoutes } from './routes/v1Emails.js';
import { registerV1JobixRoutes } from './routes/v1Jobix.js';
import { registerCronRoutes } from './routes/cron.js';
import { registerV1WebhookRoutes } from './routes/v1Webhooks.js';
import { registerSuppressionRoutes } from './routes/suppressions.js';
import { registerEmailRoutes } from './routes/emails.js';
import { registerUserRoutes } from '@aiployee/core';
import { registerSessionRoutes } from '@aiployee/core';
import { registerAgentRoutes } from './routes/agent.js';
import { registerAbeRoutes } from './routes/abe.js';
import { registerAgentChatRoutes } from './routes/agentChat.js';
import { registerLineReportRoutes } from './routes/lineReports.js';
import { registerCallAnalyticsRoutes } from './routes/callAnalytics.js';
import { registerCallAgentRoutes } from './routes/callAgents.js';
import { registerJobixTriggerRoutes } from './routes/jobixTriggers.js';
import { registerCallCampaignRoutes } from './routes/callCampaigns.js';
import { registerFlowRoutes } from './routes/flows.js';
import { registerCallHandoverRoutes } from './routes/callHandovers.js';
import { registerDomainRoutes } from './routes/domains.js';
import { registerEventWebhookRoutes } from './routes/eventWebhooks.js';
import { registerTrackRoutes } from './routes/track.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerMarketingRoutes } from './routes/marketing.js';
import { registerSegmentRoutes } from './routes/segments.js';
import { registerCampaignRoutes } from './routes/campaigns.js';
import { registerBlobRoutes } from './routes/blob.js';
import type { LlmFactory } from './agent/runner.js';
import type { WebhookSender } from './agent/webhook.js';
import type { McpProviderFactory } from './agent/mcp.js';

export interface AppDeps {
  cfg?: Config; agentLlmFactory?: LlmFactory; agentWebhookSender?: WebhookSender;
  agentMcpProviderFactory?: McpProviderFactory;
}

export async function buildApp(deps: AppDeps = {}): Promise<FastifyInstance> {
  const cfg = deps.cfg ?? loadConfig();
  const app = Fastify({
    logger: cfg.env === 'production'
      ? { level: cfg.logLevel }
      : { level: cfg.logLevel, transport: { target: 'pino-pretty', options: { colorize: true } } },
    // Default is 1 MB; raise it so campaign/email requests can carry base64 file
    // attachments (PDFs). Vercel's ~4.5 MB platform request-body cap is the real
    // ceiling; this is set above it so self-hosted runs aren't the bottleneck.
    bodyLimit: 8 * 1024 * 1024,
  });
  void logger; // imported for back-compat in case other modules import it
  app.decorate('cfg', cfg);
  const pool = getPool(cfg);
  app.decorate('pool', pool);
  // Optional injected LLM factory (tests stub this so no real OpenAI call happens).
  app.decorate('agentLlmFactory', deps.agentLlmFactory);
  app.decorate('agentWebhookSender', deps.agentWebhookSender);
  app.decorate('agentMcpProviderFactory', deps.agentMcpProviderFactory);
  // No in-process worker / scheduler. Sending happens inline in POST /v1/emails for immediate
  // sends, and via POST /v1/cron/* endpoints driven by an external cron (e.g. cron-job.org)
  // for scheduled + retry. This keeps the app stateless so it runs on Vercel/anywhere.
  await registerSessions(app, cfg, pool);
  registerCsrf(app);
  registerCtx(app);
  await registerAuthRoutes(app);
  await registerAdminTenantRoutes(app);
  await registerSmtpConfigRoutes(app);
  await registerSenderRoutes(app);
  await registerTemplateRoutes(app);
  await registerApiKeyRoutes(app);
  await registerV1EmailRoutes(app);
  await registerV1JobixRoutes(app);
  await registerCronRoutes(app);
  await registerV1WebhookRoutes(app);
  await registerSuppressionRoutes(app);
  await registerEmailRoutes(app);
  await registerUserRoutes(app);
  await registerSessionRoutes(app);
  registerHandoffRoutes(app);
  await registerAgentRoutes(app);
  registerAbeRoutes(app);
  registerAgentChatRoutes(app);
  registerLineReportRoutes(app);
  registerCallAnalyticsRoutes(app);
  registerCallAgentRoutes(app);
  registerJobixTriggerRoutes(app);
  registerCallCampaignRoutes(app);
  registerFlowRoutes(app);
  registerCallHandoverRoutes(app);
  await registerDomainRoutes(app);
  await registerEventWebhookRoutes(app);
  await registerTrackRoutes(app);
  await registerAnalyticsRoutes(app);
  await registerMarketingRoutes(app);
  await registerSegmentRoutes(app);
  await registerCampaignRoutes(app);
  await registerBlobRoutes(app);
  app.get('/healthz', async () => ({ ok: true }));

  // Static SPA serving is only used for local `npm start`. On Vercel, static assets are
  // served by the platform (outputDirectory) and the function only handles /api,/auth,/v1.
  // The command-centre deployment reuses this same buildApp but has no server/public, so
  // registration is skipped when the dir is absent (otherwise fastifyStatic throws at ready()).
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.resolve(__dirname, '../public');
  if (existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir, prefix: '/', decorateReply: false, wildcard: false });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/auth/') || req.url.startsWith('/v1/') || req.url === '/healthz') {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
      }
      return reply.type('text/html').sendFile('index.html');
    });
  }

  return app;
}

// cfg/pool are augmented by @aiployee/core (fastifyAugment). These agent factories
// are command-centre concerns and will move with the CC app.
declare module 'fastify' {
  interface FastifyInstance {
    agentLlmFactory?: import('./agent/runner.js').LlmFactory;
    agentWebhookSender?: import('./agent/webhook.js').WebhookSender;
    agentMcpProviderFactory?: import('./agent/mcp.js').McpProviderFactory;
  }
}
