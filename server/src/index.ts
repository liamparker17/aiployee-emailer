import 'dotenv/config';
import { buildApp } from './app.js';
import { logger } from '@aiployee/core';

const port = Number(process.env.PORT ?? 3000);

const app = await buildApp();
try {
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, 'server listening');
} catch (err) {
  logger.error({ err }, 'failed to start');
  process.exit(1);
}
