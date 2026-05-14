import Fastify, { type FastifyInstance } from 'fastify';
import { logger } from './util/logger.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: logger });
  app.get('/healthz', async () => ({ ok: true }));
  return app;
}
