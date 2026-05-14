import Fastify, { type FastifyInstance } from 'fastify';
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
import { startBoss, stopBoss } from './boss.js';
import { handleSendJob } from './send/worker.js';
import { registerV1EmailRoutes } from './routes/v1Emails.js';
import { startScheduler } from './send/scheduler.js';

export interface AppDeps { cfg?: Config }

export async function buildApp(deps: AppDeps = {}): Promise<FastifyInstance> {
  const cfg = deps.cfg ?? loadConfig();
  const app = Fastify({ loggerInstance: logger });
  app.decorate('cfg', cfg);
  const pool = getPool(cfg);
  app.decorate('pool', pool);
  const boss = await startBoss(cfg);
  app.addHook('onClose', async () => { await stopBoss(); });
  await boss.work<{ emailId: string }>('send-email', { teamSize: 5, teamConcurrency: 5 }, async ([job]) => {
    await handleSendJob({ pool, encKey: cfg.encKey, emailId: job.data.emailId });
  });
  const stopScheduler = startScheduler({ pool, boss });
  app.addHook('onClose', async () => { stopScheduler(); });
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
  app.get('/healthz', async () => ({ ok: true }));
  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    cfg: Config;
    pool: import('pg').Pool;
  }
}
