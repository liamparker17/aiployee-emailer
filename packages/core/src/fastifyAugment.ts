// Core-owned Fastify instance decorations. `cfg` and `pool` are decorated onto
// the app by each app's bootstrap (app.decorate('cfg'/'pool', …)); the type
// augmentation lives here in core because core's auth (csrf, ctx) reads them.
// Imported for its side effect from the core barrel so every consumer sees it.
import type { Config } from './config.js';
import type pg from 'pg';

declare module 'fastify' {
  interface FastifyInstance {
    cfg: Config;
    pool: pg.Pool;
  }
}
