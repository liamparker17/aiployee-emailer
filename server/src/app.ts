import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { logger } from './util/logger.js';
import { loadConfig, type Config } from './config.js';
import { getPool } from './db/pool.js';
import { registerSessions } from './auth/session.js';
import { registerCsrf } from './auth/csrf.js';
import { registerCtx } from './auth/ctx.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAdminTenantRoutes } from './routes/adminTenants.js';
import { registerSmtpConfigRoutes } from './routes/smtpConfigs.js';
import { registerSenderRoutes } from './routes/senders.js';
import { registerTemplateRoutes } from './routes/templates.js';
import { registerApiKeyRoutes } from './routes/apiKeys.js';
import { registerV1EmailRoutes } from './routes/v1Emails.js';
import { registerCronRoutes } from './routes/cron.js';
import { registerV1WebhookRoutes } from './routes/v1Webhooks.js';
import { registerSuppressionRoutes } from './routes/suppressions.js';
import { registerEmailRoutes } from './routes/emails.js';
import { registerUserRoutes } from './routes/users.js';
import { registerSessionRoutes } from './routes/session.js';
import { registerAgentRoutes } from './routes/agent.js';
import { registerDomainRoutes } from './routes/domains.js';
import { registerEventWebhookRoutes } from './routes/eventWebhooks.js';
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
  await registerCronRoutes(app);
  await registerV1WebhookRoutes(app);
  await registerSuppressionRoutes(app);
  await registerEmailRoutes(app);
  await registerUserRoutes(app);
  await registerSessionRoutes(app);
  await registerAgentRoutes(app);
  await registerDomainRoutes(app);
  await registerEventWebhookRoutes(app);
  app.get('/healthz', async () => ({ ok: true }));

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.resolve(__dirname, '../public');
  await app.register(fastifyStatic, { root: publicDir, prefix: '/', decorateReply: false, wildcard: false });

  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/auth/') || req.url.startsWith('/v1/') || req.url === '/healthz') {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
    }
    return reply.type('text/html').sendFile('index.html');
  });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    cfg: Config;
    pool: import('pg').Pool;
    agentLlmFactory?: import('./agent/runner.js').LlmFactory;
    agentWebhookSender?: import('./agent/webhook.js').WebhookSender;
    agentMcpProviderFactory?: import('./agent/mcp.js').McpProviderFactory;
  }
}
