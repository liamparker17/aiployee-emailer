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
export * from './auth/handoff.js';
// Slice C (backbone repos): tenants, users, api keys, contacts, lists, segments, suppressions.
export * from './repos/tenants.js';
export * from './repos/users.js';
export * from './repos/apiKeys.js';
export * from './repos/contacts.js';
export * from './repos/contactLists.js';
export * from './repos/segments.js';
export * from './repos/suppressions.js';
// Slice D (platform routes): auth/login, session, users, tenant admin, api keys.
// NOTE: these route modules import the @aiployee/core barrel internally; safe because
// all such symbols are used inside request handlers (runtime), never at module top-level.
export * from './routes/auth.js';
export * from './routes/session.js';
export * from './routes/users.js';
export * from './routes/adminTenants.js';
export * from './routes/apiKeys.js';
export * from './routes/handoff.js';
// Slice E (shared outbound-email primitives): both the email product and Abe (CC) send mail
// through these, so the transport + its data live in core. NOTE: send/* and the send repos
// import the @aiployee/core barrel internally; safe (used inside functions, not at top level).
export * from './send/sender.js';
export * from './send/render.js';
export * from './send/tracking.js';
export * from './send/dispatch.js';
export * from './send/pipeline.js';
export * from './repos/emails.js';
export * from './repos/senders.js';
export * from './repos/smtpConfigs.js';
export * from './repos/sendingDomains.js';
export * from './repos/templates.js';
export * from './repos/eventWebhooks.js';
export * from './webhooks/eventDelivery.js';
export * from './marketing/unsubscribe.js';
