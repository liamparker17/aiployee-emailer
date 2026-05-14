// Vercel Function entrypoint. Wraps the Fastify app as a serverless handler.
// All paths funnel here via vercel.ts rewrites; Fastify does the actual routing.
import 'dotenv/config';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '../server/src/app.js';

let appPromise: ReturnType<typeof buildApp> | null = null;

async function getApp() {
  if (!appPromise) appPromise = buildApp();
  const app = await appPromise;
  await app.ready();
  return app;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await getApp();
  app.server.emit('request', req, res);
}

// Vercel function config — uses Fluid Compute (Node.js, not Edge).
export const config = {
  runtime: 'nodejs',
  // Vercel default is 300s on all plans. Cron tick processes CRON_BATCH_SIZE emails
  // in parallel (default 200); 300s gives plenty of headroom even with slow SMTP.
  maxDuration: 300,
};
