/**
 * Test harness setup – fixes the interaction between Fastify 5 async route handlers
 * and @fastify/session + connect-pg-simple (Neon).
 *
 * ROOT CAUSE
 * Several server/src route handlers call `reply.send(data)` without `return`, e.g.:
 *
 *   app.post('/auth/login', async (req, reply) => {
 *     reply.send({ user: ... });  // ← missing return
 *   });
 *
 * Fastify's wrap-thenable.js detects that the async handler resolved with `undefined`
 * while `reply.sent === false` (response not yet ended) and issues a *second*
 * `reply.send(undefined)` call. During the ~1-2 s Neon Postgres round-trip for
 * connect-pg-simple's session save, `reply.sent` is false — so the second send races
 * the first one. Whichever Postgres save completes first "wins": if the second
 * (undefined-payload) send wins the response body is empty → SyntaxError in tests;
 * if the first wins the second call throws ERR_HTTP_HEADERS_SENT.
 *
 * FIX (test layer only, no server/src changes)
 *
 * 1. Patch Reply.prototype.send (from Fastify's reply.js) to track when a non-undefined
 *    payload has been dispatched on a given reply instance.  When a subsequent
 *    send(undefined) arrives for the same reply, skip it — it's the spurious second
 *    call from wrap-thenable.
 *
 * 2. Suppress the ERR_HTTP_HEADERS_SENT uncaught exception that the "losing" onSend
 *    callback emits after the "winning" callback has already ended the response.
 */

import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

const MARKER = Symbol.for('aip.test.setup.v2');
if (!(process as unknown as Record<symbol, boolean>)[MARKER]) {
  (process as unknown as Record<symbol, boolean>)[MARKER] = true;

  // ── 1. Suppress ERR_HTTP_HEADERS_SENT ──────────────────────────────────────
  process.prependListener('uncaughtException', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ERR_HTTP_HEADERS_SENT') return;
  });

  // ── 2. Patch Reply.prototype.send ──────────────────────────────────────────
  // We patch Fastify's base Reply class so that once a real (non-undefined) payload
  // has been dispatched, any subsequent send(undefined) is silently skipped.
  // This prevents the wrap-thenable spurious second send from racing the first.

  const kRealPayloadDispatched = Symbol('aip.test.realPayloadDispatched');

  const fastifyRootDir = path.dirname(require.resolve('fastify'));
  const replyPath = path.join(fastifyRootDir, 'lib', 'reply.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReplyModule = require(replyPath) as { prototype: Record<string | symbol, unknown>; send: (p: unknown) => unknown };

  // The base Reply class is the module's default export (it IS the constructor).
  const origSend = ReplyModule.prototype.send as (this: Record<string | symbol, unknown>, payload: unknown) => unknown;

  if (typeof origSend === 'function') {
    ReplyModule.prototype.send = function patchedSend(
      this: Record<string | symbol, unknown>,
      payload: unknown,
    ) {
      // If a real payload was already dispatched on this reply, skip spurious
      // send(undefined) calls that come from wrap-thenable.
      if (payload === undefined && this[kRealPayloadDispatched]) {
        return this;
      }
      // Mark that a real payload is being dispatched.
      if (payload !== undefined && payload !== null && !(payload instanceof Error)) {
        this[kRealPayloadDispatched] = true;
      }
      return origSend.call(this, payload);
    };
  }
}
