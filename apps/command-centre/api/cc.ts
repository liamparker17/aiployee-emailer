// Vercel Function entrypoint. Wraps the Fastify app as a serverless handler.
// All paths funnel here via vercel.json rewrites; Fastify does the actual routing.
import 'dotenv/config';
import type { IncomingMessage, ServerResponse } from 'node:http';
// Import the shared backend by its workspace package name (symlinked in node_modules) rather
// than a relative cross-root path: Vercel clamps relative imports that escape the Root Directory
// (apps/command-centre), but node_modules deps are traced and bundled reliably. Consumes the
// COMPILED dist (server emits dist via `npm -w server run build`).
//
// Vercel transpiles the server's ESM dist to CommonJS when bundling this function, and an ESM
// `import { buildApp }` doesn't reliably see a CJS module's named exports. Use a namespace import
// and resolve buildApp across the possible ESM/CJS interop shapes.
import * as serverApp from '@aiployee/server/dist/app.js';
const buildApp: () => Promise<{ ready(): Promise<unknown>; server: { emit(ev: string, ...args: unknown[]): void } }> =
  (serverApp as any).buildApp ?? (serverApp as any).default?.buildApp ?? (serverApp as any).default;

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
  maxDuration: 300,
};
