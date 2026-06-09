// Bundles the shared backend (server/dist/app.js + all workspace/node_modules deps) into a
// single self-contained ESM file next to the Vercel function entry (api/_app.mjs).
//
// Why this exists: the function can't import the backend across the Root Directory boundary —
// a relative import is clamped by Vercel, and importing the @aiployee/server ESM dist makes
// Vercel's function bundler transpile it to CommonJS, which breaks under the repo's
// "type":"module". A pre-built, self-contained `.mjs` sidesteps both: Vercel leaves `.mjs` as
// ESM, and there is no external dist to mis-load. The banner provides require/__dirname/__filename
// shims that some bundled CJS deps expect at runtime inside an ESM bundle.
//
// Run from the repo root (see apps/command-centre/vercel.json buildCommand), after the workspace
// build has produced server/dist.
import { build } from 'esbuild';

await build({
  entryPoints: ['server/dist/app.js'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'apps/command-centre/api/_app.mjs',
  banner: {
    js: [
      "import { createRequire as __cr } from 'module';",
      "import { fileURLToPath as __fu } from 'url';",
      "import { dirname as __dn } from 'path';",
      'const require = __cr(import.meta.url);',
      'const __filename = __fu(import.meta.url);',
      'const __dirname = __dn(__filename);',
    ].join('\n'),
  },
});

console.log('[build-fn] bundled apps/command-centre/api/_app.mjs');
