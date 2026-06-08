// @aiployee/core — backend backbone barrel.
import './fastifyAugment.js'; // side-effect: FastifyInstance cfg/pool type augmentation
// Slice A (primitives): config, util, crypto, db pool.
export * from './config.js';
export * from './util/logger.js';
export * from './util/errors.js';
export * from './crypto/enc.js';
export * from './db/pool.js';
// Slice B (auth): sessions, csrf, request context, password, api-key hashing.
export * from './auth/session.js';
export * from './auth/csrf.js';
export * from './auth/ctx.js';
export * from './auth/password.js';
export * from './auth/apiKey.js';
