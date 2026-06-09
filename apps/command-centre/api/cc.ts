// Vercel Function entrypoint. Wraps the shared Fastify app as a serverless handler.
// All paths funnel here via vercel.json rewrites; Fastify does the actual routing.
import 'dotenv/config';
import type { IncomingMessage, ServerResponse } from 'node:http';

// The shared backend can't be imported across the Root Directory boundary the normal ways:
//  - a relative `../../../server` import gets clamped by Vercel (module not found), and
//  - importing the @aiployee/server ESM dist makes Vercel's function bundler transpile it to
//    CommonJS, which then clashes with the repo's "type":"module" ("exports is not defined").
// So the build step (see vercel.json) esbuild-bundles the whole backend into a single
// self-contained ESM file, `_app.mjs`, right next to this entry. The `.mjs` extension keeps
// Vercel from re-transpiling it, and being self-contained there is no external dist to mis-load.
// We load it via a runtime dynamic import so the function entry itself stays plain ESM.
type App = { ready(): Promise<unknown>; server: { emit(ev: string, ...args: unknown[]): void } };

let appPromise: Promise<App> | null = null;

async function getApp(): Promise<App> {
  if (!appPromise) {
    appPromise = (async () => {
      // @ts-ignore - generated at build time by the esbuild step in vercel.json
      const mod = (await import('./_app.mjs')) as any;
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
