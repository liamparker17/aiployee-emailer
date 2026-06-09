// Vercel Function entrypoint. Wraps the shared Fastify app as a serverless handler.
// All paths funnel here via vercel.json rewrites; Fastify does the actual routing.
import 'dotenv/config';
import type { IncomingMessage, ServerResponse } from 'node:http';

// The shared backend (@aiployee/server) is imported by workspace package name — Vercel clamps
// relative imports that escape the Root Directory (apps/command-centre), but node_modules deps
// are traced reliably. It is loaded via a RUNTIME dynamic import (not a static `import`) on
// purpose: a static import of this ESM dep makes Vercel's bundler transpile it to CommonJS,
// which then clashes with the repo's "type":"module" ("exports is not defined" / missing named
// export). A dynamic import lets Node's own ESM loader resolve dist/app.js natively, so the
// buildApp named export is available and the function entry itself stays ESM.
type App = { ready(): Promise<unknown>; server: { emit(ev: string, ...args: unknown[]): void } };

let appPromise: Promise<App> | null = null;

async function getApp(): Promise<App> {
  if (!appPromise) {
    appPromise = (async () => {
      const mod = (await import('@aiployee/server/dist/app.js')) as any;
      const buildApp = mod.buildApp ?? mod.default?.buildApp ?? mod.default;
      return (await buildApp()) as App;
    })();
  }
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
