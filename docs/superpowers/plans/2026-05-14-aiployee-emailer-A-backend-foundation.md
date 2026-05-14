# AIployee Emailer Implementation Plan — Part A: Backend Foundation

> **Built for AIployee.** Internal multi-tenant transactional email service for AIployee's automation workflows and AIployee's clients. UI/branding match aiployee.co.za.
>
> **Cost target: ~$5/month all-in** on a single Hetzner CX11 VPS (app + Postgres + Caddy in three containers, no managed services, no Redis, tenants bring their own SMTP). See spec → "Cost (TL;DR for the CEO)" for the full breakdown.
>
> **Plan series:** A (this file) → B (send pipeline + bounces) → C (UI + docker + acceptance). Each plan must complete and pass its tests before the next begins.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a multi-tenant transactional email service with REST API and admin UI, runnable on a single small VPS via docker-compose.

**Architecture:** Single Node process (Fastify HTTP + pg-boss in-process worker + static React UI) backed by Postgres, fronted by Caddy for TLS. Tenants bring their own SMTP credentials (encrypted at rest with AES-256-GCM). Per-tenant isolation enforced through a `ctx` middleware and a thin repository layer.

**Tech Stack:** Node 24, Fastify 5, Postgres 16, pg-boss, Nodemailer, Zod, React 18 + Vite + Tailwind, bcrypt, AES-256-GCM, Caddy 2, Docker Compose. Tests with Vitest + Supertest. Migrations with node-pg-migrate.

**Spec reference:** `docs/superpowers/specs/2026-05-14-aiployee-emailer-design.md`.

---

## Repo file structure

```
package.json                   workspaces root
shared/
  package.json
  src/
    schemas.ts                 Zod schemas (request/response, shared with web)
    types.ts                   inferred TS types
server/
  package.json
  src/
    index.ts                   bootstrap: load env, build app, listen
    app.ts                     buildApp(): Fastify instance, plugins, routes
    config.ts                  loadConfig(): typed env via Zod
    db/
      pool.ts                  pg.Pool singleton
      migrate.ts               node-pg-migrate runner
    crypto/
      enc.ts                   AES-256-GCM encrypt/decrypt
    auth/
      session.ts               session plugin wiring
      password.ts              bcrypt hash/verify
      csrf.ts                  double-submit token
      apiKey.ts                generate/hash/verify api keys
      ctx.ts                   buildCtx middleware
    repos/
      tenants.ts
      users.ts
      smtpConfigs.ts
      senders.ts
      templates.ts
      apiKeys.ts
      emails.ts
      suppressions.ts
      bounceEvents.ts
    routes/
      auth.ts                  /auth/*
      adminTenants.ts          /api/admin/tenants
      senders.ts               /api/senders
      templates.ts             /api/templates
      smtpConfigs.ts           /api/smtp-configs
      apiKeys.ts               /api/api-keys
      users.ts                 /api/users
      emails.ts                /api/emails (UI read)
      v1Emails.ts              /v1/emails (API key)
      v1Webhooks.ts            /v1/webhooks/bounce/:provider
    send/
      render.ts                template variable substitution
      sender.ts                Nodemailer transport per smtp_config
      pipeline.ts              validate + insert + enqueue
      worker.ts                pg-boss handler for 'send-email' job
      scheduler.ts             pg-boss cron picking up scheduled rows
    webhooks/
      ses.ts                   SES SNS verification + parsing
      mailgun.ts               Mailgun signature verify + parsing
    util/
      errors.ts                AppError + sendError(reply, err)
      logger.ts                pino instance
  test/
    helpers/
      db.ts                    test DB setup/teardown
      app.ts                   buildTestApp()
      factories.ts             createTenant, createUser, createSender, ...
      smtp.ts                  in-memory SMTP mock (smtp-tester)
    *.test.ts                  one file per route/repo/module
  migrations/
    1700000000000_init.js
    1700000000001_sessions.js
    ...
  public/                      built UI (gitignored)
web/
  package.json
  index.html
  vite.config.ts
  tailwind.config.ts
  postcss.config.cjs
  src/
    main.tsx                   ReactDOM bootstrap, router
    api.ts                     fetch wrapper (CSRF, JSON, errors)
    auth.tsx                   useSession() context
    routes.tsx                 react-router config
    theme.css                  Tailwind directives + tokens
    components/
      AppShell.tsx
      Sidebar.tsx
      TopNav.tsx
      Table.tsx
      Button.tsx
      Input.tsx
      Modal.tsx
      Toast.tsx
    pages/
      Login.tsx
      AcceptInvite.tsx
      Dashboard.tsx
      Senders.tsx
      Templates.tsx
      SmtpConfigs.tsx
      ApiKeys.tsx
      EmailLog.tsx
      Users.tsx
      AdminTenants.tsx
docker/
  Dockerfile.app
  docker-compose.yml
  Caddyfile
  .env.example
docs/
  superpowers/
    specs/...
    plans/...
.gitignore
README.md
```

Files are kept narrow on purpose — each repo module owns one table; each route file owns one resource; the send pipeline is split into `render`, `sender`, `pipeline`, `worker`, `scheduler` so each piece is independently testable.

---

## Phases

1. **Foundation** — repo skeleton, env, Postgres, Fastify boots, healthcheck, CI-able tests
2. **Schema & migrations** — all tables in place
3. **Crypto** — AES-256-GCM encrypt/decrypt with key rotation hooks
4. **Auth** — passwords, sessions, login, CSRF
5. **Tenant context & repositories** — ctx middleware, repo pattern, isolation tests
6. **Super-admin: tenants & invites**
7. **SMTP configs** (with test-send)
8. **Senders**
9. **Templates** (with variable extraction)
10. **API keys**
11. **Send pipeline** — POST /v1/emails, render, queue, worker, immediate sends
12. **Scheduled sends**
13. **Bounces & suppressions** — webhooks, suppression check pre-send
14. **Email log** (UI read endpoints)
15. **UI shell** — Vite, Tailwind with aiployee.co.za palette, routing, AppShell
16. **UI pages** — login, dashboard, senders, smtp, templates, api-keys, log, users, admin
17. **Docker & Caddy** — production compose
18. **Acceptance pass** — walk all 10 acceptance criteria

Each phase below is a sequence of bite-sized tasks. Commit after every task that has visible changes.

---

# Phase 1 — Foundation

### Task 1.1: Initialize npm workspaces

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `.nvmrc`

- [ ] **Step 1: Create the root `package.json`**

```json
{
  "name": "aiployee-emailer",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "workspaces": ["shared", "server", "web"],
  "scripts": {
    "dev": "npm -w server run dev",
    "dev:web": "npm -w web run dev",
    "build": "npm -w shared run build && npm -w web run build && npm -w server run build",
    "test": "npm -w server run test",
    "migrate": "npm -w server run migrate"
  },
  "engines": { "node": ">=24" }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules
dist
server/public
.env
*.log
coverage
.DS_Store
```

- [ ] **Step 3: Create `.nvmrc`**

```
24
```

- [ ] **Step 4: Initialize git and commit**

```bash
git init
git add .
git commit -m "chore: init npm workspaces"
```

### Task 1.2: Shared package (Zod schemas live here)

**Files:**
- Create: `shared/package.json`
- Create: `shared/tsconfig.json`
- Create: `shared/src/index.ts`

- [ ] **Step 1: `shared/package.json`**

```json
{
  "name": "@aiployee/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "build": "tsc -p tsconfig.json --noEmit" },
  "dependencies": { "zod": "^3.23.8" },
  "devDependencies": { "typescript": "^5.6.2" }
}
```

- [ ] **Step 2: `shared/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: `shared/src/index.ts`**

```ts
export const ROLES = ['super_admin', 'tenant_admin', 'tenant_user'] as const;
export type Role = (typeof ROLES)[number];
```

- [ ] **Step 4: Install and commit**

```bash
npm install
git add .
git commit -m "feat(shared): scaffold shared types package"
```

### Task 1.3: Server package skeleton

**Files:**
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/src/index.ts`
- Create: `server/src/app.ts`
- Create: `server/src/util/logger.ts`

- [ ] **Step 1: `server/package.json`**

```json
{
  "name": "@aiployee/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "migrate": "node-pg-migrate -m migrations -d DATABASE_URL up",
    "migrate:down": "node-pg-migrate -m migrations -d DATABASE_URL down"
  },
  "dependencies": {
    "@aiployee/shared": "*",
    "@fastify/cookie": "^9.4.0",
    "@fastify/cors": "^9.0.1",
    "@fastify/static": "^7.0.4",
    "bcryptjs": "^2.4.3",
    "dotenv": "^16.4.5",
    "fastify": "^5.0.0",
    "nodemailer": "^6.9.15",
    "pg": "^8.13.0",
    "pg-boss": "^10.1.5",
    "pino": "^9.4.0",
    "pino-pretty": "^11.2.2",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/bcryptjs": "^2.4.6",
    "@types/node": "^22.7.4",
    "@types/nodemailer": "^6.4.16",
    "@types/pg": "^8.11.10",
    "node-pg-migrate": "^7.6.1",
    "smtp-tester": "^2.1.0",
    "supertest": "^7.0.0",
    "tsx": "^4.19.1",
    "typescript": "^5.6.2",
    "vitest": "^2.1.1"
  }
}
```

- [ ] **Step 2: `server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: `server/src/util/logger.ts`**

```ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV === 'production'
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true } },
});
```

- [ ] **Step 4: `server/src/app.ts`**

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import { logger } from './util/logger.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: logger });
  app.get('/healthz', async () => ({ ok: true }));
  return app;
}
```

- [ ] **Step 5: `server/src/index.ts`**

```ts
import 'dotenv/config';
import { buildApp } from './app.js';
import { logger } from './util/logger.js';

const port = Number(process.env.PORT ?? 3000);

const app = await buildApp();
try {
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, 'server listening');
} catch (err) {
  logger.error({ err }, 'failed to start');
  process.exit(1);
}
```

- [ ] **Step 6: Install, smoke test, commit**

```bash
npm install
npm -w server run dev    # ctrl-c after seeing "server listening"
git add .
git commit -m "feat(server): fastify skeleton with /healthz"
```

### Task 1.4: Vitest with healthz test

**Files:**
- Create: `server/vitest.config.ts`
- Create: `server/test/healthz.test.ts`

- [ ] **Step 1: `server/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: [],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 10000,
  },
});
```

- [ ] **Step 2: Write the failing test `server/test/healthz.test.ts`**

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';

const app = await buildApp();

afterAll(async () => { await app.close(); });

describe('healthz', () => {
  it('responds 200 ok:true', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 3: Run tests**

```bash
npm -w server test
```

Expected: 1 passed.

- [ ] **Step 4: Commit**

```bash
git add .
git commit -m "test(server): healthz integration test"
```

### Task 1.5: Typed config loader

**Files:**
- Create: `server/src/config.ts`
- Create: `server/test/config.test.ts`
- Create: `docker/.env.example`

- [ ] **Step 1: Write the failing test `server/test/config.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('parses required env', () => {
    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3000',
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      SESSION_SECRET: 'a'.repeat(32),
      EMAILER_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
      PUBLIC_BASE_URL: 'http://localhost:3000',
    });
    expect(cfg.port).toBe(3000);
    expect(cfg.encKey).toHaveLength(32);
  });

  it('rejects too-short SESSION_SECRET', () => {
    expect(() => loadConfig({
      DATABASE_URL: 'postgres://x',
      SESSION_SECRET: 'short',
      EMAILER_ENC_KEY: Buffer.alloc(32).toString('base64'),
      PUBLIC_BASE_URL: 'http://x',
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npm -w server test` (loadConfig undefined)

- [ ] **Step 3: Implement `server/src/config.ts`**

```ts
import { z } from 'zod';

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  EMAILER_ENC_KEY: z.string().refine(
    s => Buffer.from(s, 'base64').length === 32,
    'EMAILER_ENC_KEY must be 32 bytes base64-encoded'
  ),
  PUBLIC_BASE_URL: z.string().url(),
  LOG_LEVEL: z.string().default('info'),
});

export type Config = {
  env: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  sessionSecret: string;
  encKey: Buffer;
  publicBaseUrl: string;
  logLevel: string;
};

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Config {
  const p = Schema.parse(env);
  return {
    env: p.NODE_ENV,
    port: p.PORT,
    databaseUrl: p.DATABASE_URL,
    sessionSecret: p.SESSION_SECRET,
    encKey: Buffer.from(p.EMAILER_ENC_KEY, 'base64'),
    publicBaseUrl: p.PUBLIC_BASE_URL,
    logLevel: p.LOG_LEVEL,
  };
}
```

- [ ] **Step 4: `docker/.env.example`**

```
NODE_ENV=production
PORT=3000
DATABASE_URL=postgres://emailer:emailer@postgres:5432/emailer
SESSION_SECRET=replace-with-32+char-random-string-XXXXXXXX
# 32-byte base64; generate with: openssl rand -base64 32
EMAILER_ENC_KEY=
PUBLIC_BASE_URL=https://email.example.com
LOG_LEVEL=info
POSTGRES_USER=emailer
POSTGRES_PASSWORD=emailer
POSTGRES_DB=emailer
```

- [ ] **Step 5: Run tests, commit**

```bash
npm -w server test
git add .
git commit -m "feat(server): typed config loader with zod validation"
```

### Task 1.6: Local Postgres for tests via docker

**Files:**
- Create: `docker/docker-compose.dev.yml`
- Create: `server/test/helpers/db.ts`

- [ ] **Step 1: `docker/docker-compose.dev.yml`**

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: emailer
      POSTGRES_PASSWORD: emailer
      POSTGRES_DB: emailer
    ports: ["5433:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U emailer"]
      interval: 2s
      timeout: 2s
      retries: 20
```

- [ ] **Step 2: Bring it up**

```bash
docker compose -f docker/docker-compose.dev.yml up -d
docker compose -f docker/docker-compose.dev.yml ps
```

Expected: `postgres` healthy.

- [ ] **Step 3: `server/test/helpers/db.ts`**

```ts
import pg from 'pg';

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer';

export function makePool() {
  return new pg.Pool({ connectionString: TEST_DB_URL, max: 4 });
}

export async function truncateAll(pool: pg.Pool) {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'pgmigrations'`
  );
  if (rows.length === 0) return;
  const list = rows.map(r => `"${r.tablename}"`).join(', ');
  await pool.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}
```

- [ ] **Step 4: Commit**

```bash
git add .
git commit -m "chore: dev postgres compose + test db helper"
```

---

# Phase 2 — Schema & migrations

### Task 2.1: Migration tooling + first migration (extensions)

**Files:**
- Create: `server/migrations/1700000000000_init.cjs`

- [ ] **Step 1: `server/migrations/1700000000000_init.cjs`**

```js
/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.createExtension('pgcrypto', { ifNotExists: true });
};
exports.down = (pgm) => {
  pgm.dropExtension('pgcrypto', { ifExists: true });
};
```

- [ ] **Step 2: Run migration**

```bash
DATABASE_URL=postgres://emailer:emailer@localhost:5433/emailer npx -w server node-pg-migrate -m server/migrations up
```

Expected: `Migrations complete.`

- [ ] **Step 3: Commit**

```bash
git add . && git commit -m "feat(db): enable pgcrypto"
```

### Task 2.2: Tenants, users, sessions

**Files:**
- Create: `server/migrations/1700000000001_tenants_users_sessions.cjs`

- [ ] **Step 1: Migration file**

```js
/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.createTable('tenants', {
    id:         { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name:       { type: 'text', notNull: true },
    slug:       { type: 'text', notNull: true, unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createTable('users', {
    id:                { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:         { type: 'uuid', references: 'tenants(id)', onDelete: 'CASCADE' },
    email:             { type: 'text', notNull: true },
    password_hash:     { type: 'text', notNull: true },
    role:              { type: 'text', notNull: true, check: "role IN ('super_admin','tenant_admin','tenant_user')" },
    invite_token:      { type: 'text' },
    invite_expires_at: { type: 'timestamptz' },
    created_at:        { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('users', 'users_tenant_email_uniq', { unique: ['tenant_id', 'email'] });
  pgm.createIndex('users', ['invite_token'], { where: 'invite_token IS NOT NULL' });
  pgm.createTable('sessions', {
    sid:    { type: 'text', primaryKey: true },
    sess:   { type: 'jsonb', notNull: true },
    expire: { type: 'timestamptz', notNull: true },
  });
  pgm.createIndex('sessions', ['expire']);
};
exports.down = (pgm) => {
  pgm.dropTable('sessions');
  pgm.dropTable('users');
  pgm.dropTable('tenants');
};
```

- [ ] **Step 2: Run + commit**

```bash
DATABASE_URL=postgres://emailer:emailer@localhost:5433/emailer npx -w server node-pg-migrate -m server/migrations up
git add . && git commit -m "feat(db): tenants, users, sessions"
```

### Task 2.3: SMTP configs and senders

**Files:**
- Create: `server/migrations/1700000000002_smtp_senders.cjs`

- [ ] **Step 1: Migration**

```js
/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.createTable('smtp_configs', {
    id:                 { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:          { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    name:               { type: 'text', notNull: true },
    host:               { type: 'text', notNull: true },
    port:               { type: 'int',  notNull: true },
    secure:             { type: 'boolean', notNull: true, default: false },
    username:           { type: 'text', notNull: true },
    password_encrypted: { type: 'bytea', notNull: true },
    from_domain:        { type: 'text', notNull: true },
    is_default:         { type: 'boolean', notNull: true, default: false },
    created_at:         { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('smtp_configs', 'smtp_tenant_name_uniq', { unique: ['tenant_id', 'name'] });
  pgm.createTable('senders', {
    id:             { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:      { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    email:          { type: 'text', notNull: true },
    display_name:   { type: 'text', notNull: true },
    reply_to:       { type: 'text' },
    smtp_config_id: { type: 'uuid', notNull: true, references: 'smtp_configs(id)' },
    is_default:     { type: 'boolean', notNull: true, default: false },
    created_at:     { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('senders', 'senders_tenant_email_uniq', { unique: ['tenant_id', 'email'] });
};
exports.down = (pgm) => {
  pgm.dropTable('senders');
  pgm.dropTable('smtp_configs');
};
```

- [ ] **Step 2: Run + commit**

```bash
DATABASE_URL=postgres://emailer:emailer@localhost:5433/emailer npx -w server node-pg-migrate -m server/migrations up
git add . && git commit -m "feat(db): smtp_configs and senders"
```

### Task 2.4: Templates and api_keys

**Files:**
- Create: `server/migrations/1700000000003_templates_apikeys.cjs`

- [ ] **Step 1: Migration**

```js
/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.createTable('templates', {
    id:         { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:  { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    name:       { type: 'text', notNull: true },
    subject:    { type: 'text', notNull: true },
    body_html:  { type: 'text', notNull: true },
    body_text:  { type: 'text' },
    variables:  { type: 'jsonb', notNull: true, default: '[]' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('templates', 'templates_tenant_name_uniq', { unique: ['tenant_id', 'name'] });
  pgm.createTable('api_keys', {
    id:           { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:    { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    name:         { type: 'text', notNull: true },
    key_hash:     { type: 'text', notNull: true, unique: true },
    key_prefix:   { type: 'text', notNull: true },
    created_at:   { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_used_at: { type: 'timestamptz' },
    revoked_at:   { type: 'timestamptz' },
  });
  pgm.createIndex('api_keys', ['tenant_id']);
};
exports.down = (pgm) => {
  pgm.dropTable('api_keys');
  pgm.dropTable('templates');
};
```

- [ ] **Step 2: Run + commit**

```bash
DATABASE_URL=postgres://emailer:emailer@localhost:5433/emailer npx -w server node-pg-migrate -m server/migrations up
git add . && git commit -m "feat(db): templates and api_keys"
```

### Task 2.5: Emails, bounce_events, suppressions

**Files:**
- Create: `server/migrations/1700000000004_emails_bounces_suppressions.cjs`

- [ ] **Step 1: Migration**

```js
/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.createTable('emails', {
    id:             { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:      { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    sender_id:      { type: 'uuid', notNull: true, references: 'senders(id)' },
    to_addr:        { type: 'text', notNull: true },
    cc:             { type: 'text[]', notNull: true, default: '{}' },
    bcc:            { type: 'text[]', notNull: true, default: '{}' },
    reply_to:       { type: 'text' },
    subject:        { type: 'text', notNull: true },
    body_html:      { type: 'text', notNull: true },
    body_text:      { type: 'text' },
    template_id:    { type: 'uuid', references: 'templates(id)' },
    attachments:    { type: 'jsonb', notNull: true, default: '[]' },
    status:         { type: 'text', notNull: true, check: "status IN ('queued','sending','sent','failed','bounced','complained','suppressed')" },
    scheduled_for:  { type: 'timestamptz' },
    sent_at:        { type: 'timestamptz' },
    error:          { type: 'text' },
    message_id:     { type: 'text' },
    api_key_id:     { type: 'uuid', references: 'api_keys(id)' },
    created_at:     { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('emails', ['tenant_id', { name: 'created_at', sort: 'DESC' }]);
  pgm.createIndex('emails', ['scheduled_for'], { where: "status = 'queued'", name: 'emails_queued_scheduled_idx' });
  pgm.createIndex('emails', ['message_id'], { where: 'message_id IS NOT NULL' });
  pgm.createTable('bounce_events', {
    id:           { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    email_id:     { type: 'uuid', notNull: true, references: 'emails(id)', onDelete: 'CASCADE' },
    type:         { type: 'text', notNull: true, check: "type IN ('bounce','complaint','delivery')" },
    raw_payload:  { type: 'jsonb', notNull: true },
    received_at:  { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createTable('suppressions', {
    id:         { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:  { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    address:    { type: 'text', notNull: true },
    reason:     { type: 'text', notNull: true, check: "reason IN ('bounce','complaint','manual')" },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('suppressions', 'suppressions_tenant_address_uniq', { unique: ['tenant_id', 'address'] });
};
exports.down = (pgm) => {
  pgm.dropTable('suppressions');
  pgm.dropTable('bounce_events');
  pgm.dropTable('emails');
};
```

- [ ] **Step 2: Run + commit**

```bash
DATABASE_URL=postgres://emailer:emailer@localhost:5433/emailer npx -w server node-pg-migrate -m server/migrations up
git add . && git commit -m "feat(db): emails, bounce_events, suppressions"
```

### Task 2.6: DB pool + smoke test

**Files:**
- Create: `server/src/db/pool.ts`
- Create: `server/test/db.test.ts`

- [ ] **Step 1: Failing test `server/test/db.test.ts`**

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { makePool } from './helpers/db.js';

const pool = makePool();
afterAll(async () => { await pool.end(); });

describe('db connectivity', () => {
  it('lists migrated tables', async () => {
    const r = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
    );
    const names = r.rows.map(x => x.tablename);
    for (const t of ['tenants','users','sessions','smtp_configs','senders','templates','api_keys','emails','bounce_events','suppressions']) {
      expect(names).toContain(t);
    }
  });
});
```

- [ ] **Step 2: Run** — `npm -w server test`. Expected: PASS.

- [ ] **Step 3: `server/src/db/pool.ts`**

```ts
import pg from 'pg';
import type { Config } from '../config.js';

let pool: pg.Pool | null = null;

export function getPool(cfg: Config): pg.Pool {
  if (!pool) pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 10 });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
}
```

- [ ] **Step 4: Commit**

```bash
git add . && git commit -m "feat(db): connection pool + smoke test"
```

---

# Phase 3 — Crypto

### Task 3.1: AES-256-GCM encrypt/decrypt

**Files:**
- Create: `server/src/crypto/enc.ts`
- Create: `server/test/crypto.test.ts`

- [ ] **Step 1: Failing test `server/test/crypto.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../src/crypto/enc.js';

const KEY = Buffer.alloc(32, 7);

describe('AES-256-GCM', () => {
  it('round-trips plaintext', () => {
    const ct = encrypt('hello world', KEY);
    expect(ct).toBeInstanceOf(Buffer);
    expect(decrypt(ct, KEY)).toBe('hello world');
  });
  it('rejects tampered ciphertext', () => {
    const ct = encrypt('secret', KEY);
    ct[ct.length - 1] ^= 0x01;
    expect(() => decrypt(ct, KEY)).toThrow();
  });
  it('produces different ciphertext each call (random IV)', () => {
    expect(encrypt('same', KEY).equals(encrypt('same', KEY))).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `server/src/crypto/enc.ts`**

```ts
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const IV_LEN = 12;
const TAG_LEN = 16;

export function encrypt(plaintext: string, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error('key must be 32 bytes');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

export function decrypt(blob: Buffer, key: Buffer): string {
  if (key.length !== 32) throw new Error('key must be 32 bytes');
  if (blob.length < IV_LEN + TAG_LEN) throw new Error('ciphertext too short');
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const dec = createDecipheriv('aes-256-gcm', key, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
}
```

- [ ] **Step 4: Run, expect PASS. Commit.**

```bash
npm -w server test
git add . && git commit -m "feat(crypto): AES-256-GCM encrypt/decrypt"
```

---

# Phase 4 — Auth primitives

### Task 4.1: Password hashing

**Files:** Create `server/src/auth/password.ts`, `server/test/password.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.js';

describe('password', () => {
  it('hashes and verifies', async () => {
    const h = await hashPassword('correct horse');
    expect(h).not.toBe('correct horse');
    expect(await verifyPassword('correct horse', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `server/src/auth/password.ts`**

```ts
import bcrypt from 'bcryptjs';
const COST = 12;
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
```

- [ ] **Step 4: Run, PASS, commit.**

```bash
npm -w server test
git add . && git commit -m "feat(auth): bcrypt password hashing"
```

### Task 4.2: API key generation/verification

**Files:** Create `server/src/auth/apiKey.ts`, `server/test/apiKey.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { generateApiKey, hashApiKey, prefixOf } from '../src/auth/apiKey.js';

describe('api key', () => {
  it('generates keys with aip_live_ prefix', () => {
    const k = generateApiKey();
    expect(k.startsWith('aip_live_')).toBe(true);
    expect(k.length).toBeGreaterThan(20);
  });
  it('hash is deterministic and not the plaintext', () => {
    const k = 'aip_live_abc123';
    const h = hashApiKey(k);
    expect(h).not.toBe(k);
    expect(h).toBe(hashApiKey(k));
  });
  it('prefix is first 13 chars', () => {
    expect(prefixOf('aip_live_abcdefgh')).toBe('aip_live_abcd');
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `server/src/auth/apiKey.ts`**

```ts
import { randomBytes, createHash } from 'node:crypto';

export function generateApiKey(): string {
  return 'aip_live_' + randomBytes(24).toString('base64url');
}
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
export function prefixOf(key: string): string {
  return key.slice(0, 13);
}
```

- [ ] **Step 4: Run, PASS, commit.**

```bash
npm -w server test
git add . && git commit -m "feat(auth): api key generation, hashing, prefixing"
```

### Task 4.3: Session plugin (Postgres-backed)

**Files:** Create `server/src/auth/session.ts`, modify `server/src/app.ts`, `server/src/config.ts`

- [ ] **Step 1: Add cookie + session deps to `server/package.json`** (already there: `@fastify/cookie`). Add:

```bash
npm -w server install @fastify/session connect-pg-simple
```

- [ ] **Step 2: Implement `server/src/auth/session.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';
import type pg from 'pg';
import type { Config } from '../config.js';

export async function registerSessions(app: FastifyInstance, cfg: Config, pool: pg.Pool) {
  const PgStore = connectPgSimple(session);
  await app.register(fastifyCookie);
  await app.register(fastifySession, {
    secret: cfg.sessionSecret,
    cookieName: 'aip_sid',
    cookie: {
      httpOnly: true,
      secure: cfg.env === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
    },
    rolling: true,
    saveUninitialized: false,
    store: new PgStore({ pool, tableName: 'sessions' }) as never,
  });
}

declare module 'fastify' {
  interface Session {
    userId?: string;
    tenantId?: string | null;
    role?: 'super_admin' | 'tenant_admin' | 'tenant_user';
  }
}
```

- [ ] **Step 3: Wire into `server/src/app.ts`**

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import { logger } from './util/logger.js';
import { loadConfig, type Config } from './config.js';
import { getPool } from './db/pool.js';
import { registerSessions } from './auth/session.js';

export interface AppDeps { cfg?: Config }

export async function buildApp(deps: AppDeps = {}): Promise<FastifyInstance> {
  const cfg = deps.cfg ?? loadConfig();
  const app = Fastify({ loggerInstance: logger });
  app.decorate('cfg', cfg);
  const pool = getPool(cfg);
  app.decorate('pool', pool);
  await registerSessions(app, cfg, pool);
  app.get('/healthz', async () => ({ ok: true }));
  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    cfg: Config;
    pool: import('pg').Pool;
  }
}
```

- [ ] **Step 4: Update `server/test/healthz.test.ts` to inject test config**

```ts
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig({
  NODE_ENV: 'test',
  PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
});
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => { app = await buildApp({ cfg }); });
afterAll(async () => { await app.close(); });

describe('healthz', () => {
  it('responds 200 ok:true', async () => {
    const r = await app.inject({ method: 'GET', url: '/healthz' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 5: Run, PASS, commit.**

```bash
npm -w server test
git add . && git commit -m "feat(auth): postgres-backed session plugin"
```

### Task 4.4: CSRF double-submit

**Files:** Create `server/src/auth/csrf.ts`, `server/test/csrf.test.ts`, register in `app.ts`

- [ ] **Step 1: Failing test `server/test/csrf.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
});
let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  app = await buildApp({ cfg });
  app.post('/echo', async (req) => ({ ok: true }));
});
afterAll(async () => { await app.close(); });

describe('csrf', () => {
  it('rejects POST without csrf token', async () => {
    const r = await app.inject({ method: 'POST', url: '/echo' });
    expect(r.statusCode).toBe(403);
  });
  it('accepts POST when X-CSRF-Token matches cookie', async () => {
    const get = await app.inject({ method: 'GET', url: '/healthz' });
    const setCookie = get.headers['set-cookie'] as string | string[];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const sidCookie = cookies.find(c => c.startsWith('aip_sid='))!;
    const csrfCookie = cookies.find(c => c.startsWith('aip_csrf='))!;
    const csrfVal = decodeURIComponent(csrfCookie.split(';')[0].split('=')[1]);
    const r = await app.inject({
      method: 'POST', url: '/echo',
      headers: { cookie: `${sidCookie.split(';')[0]}; ${csrfCookie.split(';')[0]}`, 'x-csrf-token': csrfVal },
    });
    expect(r.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Implement `server/src/auth/csrf.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';

const COOKIE = 'aip_csrf';
const HEADER = 'x-csrf-token';

export function registerCsrf(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    const existing = req.cookies[COOKIE];
    if (!existing) {
      const token = randomBytes(24).toString('base64url');
      reply.setCookie(COOKIE, token, {
        path: '/', sameSite: 'lax', httpOnly: false,
        secure: app.cfg.env === 'production',
      });
      (req as unknown as { csrfToken: string }).csrfToken = token;
    } else {
      (req as unknown as { csrfToken: string }).csrfToken = existing;
    }
  });
  app.addHook('preHandler', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    if (req.url.startsWith('/v1/')) return; // API key routes use bearer auth, not CSRF
    if (req.url === '/healthz') return;
    const cookie = req.cookies[COOKIE];
    const header = req.headers[HEADER];
    if (!cookie || !header || cookie !== header) {
      reply.code(403).send({ error: { code: 'csrf_invalid', message: 'CSRF token missing or invalid' } });
    }
  });
}
```

- [ ] **Step 3: Wire into `app.ts`** — add `import { registerCsrf } from './auth/csrf.js';` and call `registerCsrf(app);` after `registerSessions`.
- [ ] **Step 4: Run, PASS, commit.**

```bash
npm -w server test
git add . && git commit -m "feat(auth): CSRF double-submit middleware"
```

---

# Phase 5 — Tenant context, repos, isolation

### Task 5.1: Common error type + reply helper

**Files:** Create `server/src/util/errors.ts`

- [ ] **Step 1: Implement**

```ts
import type { FastifyReply } from 'fastify';

export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
    public readonly details?: unknown,
  ) { super(message); }
}

export function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof AppError) {
    return reply.code(err.httpStatus).send({ error: { code: err.code, message: err.message, details: err.details } });
  }
  reply.log.error({ err }, 'unhandled');
  return reply.code(500).send({ error: { code: 'internal', message: 'Internal server error' } });
}
```

- [ ] **Step 2: Commit.**

```bash
git add . && git commit -m "feat(util): AppError + sendError helper"
```

### Task 5.2: Test factories (db helpers)

**Files:** Create `server/test/helpers/factories.ts`

- [ ] **Step 1: Implement**

```ts
import type pg from 'pg';
import { hashPassword } from '../../src/auth/password.js';

export async function createTenant(pool: pg.Pool, name = 'Tenant ' + Math.random().toString(36).slice(2, 7)) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const r = await pool.query<{ id: string; name: string; slug: string }>(
    `INSERT INTO tenants(name, slug) VALUES ($1,$2) RETURNING *`, [name, slug]);
  return r.rows[0];
}

export async function createUser(pool: pg.Pool, opts: {
  tenantId: string | null; email: string; password?: string; role: 'super_admin' | 'tenant_admin' | 'tenant_user';
}) {
  const hash = await hashPassword(opts.password ?? 'pw-' + Math.random());
  const r = await pool.query<{ id: string; email: string; role: string; tenant_id: string | null }>(
    `INSERT INTO users(tenant_id,email,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id,email,role,tenant_id`,
    [opts.tenantId, opts.email, hash, opts.role]);
  return r.rows[0];
}
```

- [ ] **Step 2: Commit.**

```bash
git add . && git commit -m "test: tenant + user factories"
```

### Task 5.3: Ctx middleware (session OR API key → req.ctx)

**Files:** Create `server/src/auth/ctx.ts`

- [ ] **Step 1: Implement**

```ts
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { hashApiKey } from './apiKey.js';
import { AppError } from '../util/errors.js';

export interface Ctx {
  tenantId: string;            // empty string '' for super-admin
  userId?: string;
  apiKeyId?: string;
  role: 'super_admin' | 'tenant_admin' | 'tenant_user' | 'api_key';
}

declare module 'fastify' {
  interface FastifyRequest { ctx?: Ctx }
}

export function registerCtx(app: FastifyInstance) {
  app.addHook('preHandler', async (req: FastifyRequest, reply) => {
    if (req.url === '/healthz' || req.url.startsWith('/v1/webhooks/')) return;

    if (req.url.startsWith('/v1/')) {
      const auth = req.headers.authorization;
      if (!auth?.startsWith('Bearer ')) {
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'Missing bearer token' } });
      }
      const key = auth.slice(7).trim();
      const hash = hashApiKey(key);
      const r = await app.pool.query<{ id: string; tenant_id: string }>(
        `UPDATE api_keys SET last_used_at = now()
         WHERE key_hash = $1 AND revoked_at IS NULL
         RETURNING id, tenant_id`, [hash]);
      if (r.rowCount === 0) {
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'Invalid API key' } });
      }
      req.ctx = { tenantId: r.rows[0].tenant_id, apiKeyId: r.rows[0].id, role: 'api_key' };
      return;
    }

    if (req.url.startsWith('/api/') || req.url.startsWith('/auth/')) {
      const sess = req.session;
      if (!sess?.userId) {
        if (req.url === '/auth/login' || req.url === '/auth/invite/accept') return;
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'Not signed in' } });
      }
      req.ctx = {
        tenantId: sess.tenantId ?? '',
        userId: sess.userId,
        role: sess.role!,
      };
    }
  });
}

export function requireCtx(req: FastifyRequest): Ctx {
  if (!req.ctx) throw new AppError('unauthorized', 401, 'No context');
  return req.ctx;
}

export function requireTenantCtx(req: FastifyRequest): Ctx & { tenantId: string } {
  const ctx = requireCtx(req);
  if (!ctx.tenantId && ctx.role !== 'super_admin') {
    throw new AppError('forbidden', 403, 'Tenant context required');
  }
  return ctx as Ctx & { tenantId: string };
}

export function requireSuperAdmin(req: FastifyRequest): Ctx {
  const ctx = requireCtx(req);
  if (ctx.role !== 'super_admin') throw new AppError('forbidden', 403, 'Super admin required');
  return ctx;
}
```

- [ ] **Step 2: Wire into `app.ts`** — `import { registerCtx } from './auth/ctx.js';` then `registerCtx(app);` after `registerCsrf(app);`.
- [ ] **Step 3: Commit.**

```bash
git add . && git commit -m "feat(auth): ctx middleware (session + api key)"
```

### Task 5.4: Tenant repo

**Files:** Create `server/src/repos/tenants.ts`, `server/test/tenants.repo.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant as create } from '../src/repos/tenants.js';
import { listTenants } from '../src/repos/tenants.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('tenants repo', () => {
  it('creates and lists', async () => {
    const t = await create(pool, { name: 'Acme', slug: 'acme' });
    expect(t.name).toBe('Acme');
    const all = await listTenants(pool);
    expect(all).toHaveLength(1);
  });
  it('rejects duplicate slug', async () => {
    await create(pool, { name: 'A', slug: 'dup' });
    await expect(create(pool, { name: 'B', slug: 'dup' })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `server/src/repos/tenants.ts`**

```ts
import type pg from 'pg';

export interface Tenant { id: string; name: string; slug: string; created_at: Date }

export async function createTenant(pool: pg.Pool, input: { name: string; slug: string }): Promise<Tenant> {
  const r = await pool.query<Tenant>(
    `INSERT INTO tenants(name, slug) VALUES ($1, $2) RETURNING id, name, slug, created_at`,
    [input.name, input.slug],
  );
  return r.rows[0];
}

export async function listTenants(pool: pg.Pool): Promise<Tenant[]> {
  const r = await pool.query<Tenant>(`SELECT id, name, slug, created_at FROM tenants ORDER BY created_at DESC`);
  return r.rows;
}

export async function getTenant(pool: pg.Pool, id: string): Promise<Tenant | null> {
  const r = await pool.query<Tenant>(`SELECT id, name, slug, created_at FROM tenants WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}
```

- [ ] **Step 4: Run, PASS, commit.**

```bash
npm -w server test
git add . && git commit -m "feat(repos): tenants repo"
```

---

# Phase 6 — Auth routes + super-admin tenants

### Task 6.1: Login route

**Files:** Create `server/src/routes/auth.ts`, `server/test/auth.test.ts`. Modify `server/src/app.ts` to register routes.

- [ ] **Step 1: Failing test `server/test/auth.test.ts`**

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createUser } from './helpers/factories.js';

const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
});
let app: Awaited<ReturnType<typeof buildApp>>;
const pool = makePool();

beforeAll(async () => { app = await buildApp({ cfg }); });
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await pool.end(); });

async function csrfHeaders() {
  const g = await app.inject({ method: 'GET', url: '/healthz' });
  const setCookie = g.headers['set-cookie'] as string | string[];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const csrf = cookies.find(c => c.startsWith('aip_csrf='))!.split(';')[0];
  const sid  = cookies.find(c => c.startsWith('aip_sid='))!.split(';')[0];
  const csrfVal = decodeURIComponent(csrf.split('=')[1]);
  return { cookie: `${sid}; ${csrf}`, 'x-csrf-token': csrfVal };
}

describe('auth', () => {
  it('logs in valid super_admin', async () => {
    await createUser(pool, { tenantId: null, email: 'root@x.com', password: 'pw12345!', role: 'super_admin' });
    const headers = await csrfHeaders();
    const r = await app.inject({
      method: 'POST', url: '/auth/login', headers,
      payload: { email: 'root@x.com', password: 'pw12345!' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ user: { email: 'root@x.com', role: 'super_admin' } });
  });

  it('rejects bad password', async () => {
    await createUser(pool, { tenantId: null, email: 'root@x.com', password: 'pw12345!', role: 'super_admin' });
    const headers = await csrfHeaders();
    const r = await app.inject({
      method: 'POST', url: '/auth/login', headers,
      payload: { email: 'root@x.com', password: 'wrong' },
    });
    expect(r.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run, expect FAIL (route missing).**
- [ ] **Step 3: Implement `server/src/routes/auth.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyPassword, hashPassword } from '../auth/password.js';
import { AppError, sendError } from '../util/errors.js';

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });
const AcceptBody = z.object({ token: z.string().min(10), password: z.string().min(8) });

export async function registerAuthRoutes(app: FastifyInstance) {
  app.post('/auth/login', async (req, reply) => {
    try {
      const body = LoginBody.parse(req.body);
      const r = await app.pool.query<{ id: string; tenant_id: string | null; password_hash: string; role: string }>(
        `SELECT id, tenant_id, password_hash, role FROM users WHERE email = $1 LIMIT 1`,
        [body.email],
      );
      const u = r.rows[0];
      if (!u || !(await verifyPassword(body.password, u.password_hash))) {
        throw new AppError('invalid_credentials', 401, 'Invalid email or password');
      }
      req.session.userId = u.id;
      req.session.tenantId = u.tenant_id;
      req.session.role = u.role as never;
      reply.send({ user: { id: u.id, email: body.email, role: u.role, tenantId: u.tenant_id } });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/auth/logout', async (req, reply) => {
    await req.session.destroy();
    reply.send({ ok: true });
  });

  app.post('/auth/invite/accept', async (req, reply) => {
    try {
      const body = AcceptBody.parse(req.body);
      const r = await app.pool.query<{ id: string }>(
        `UPDATE users
         SET password_hash = $2, invite_token = NULL, invite_expires_at = NULL
         WHERE invite_token = $1 AND invite_expires_at > now()
         RETURNING id`,
        [body.token, await hashPassword(body.password)],
      );
      if (r.rowCount === 0) throw new AppError('invalid_token', 400, 'Invite token invalid or expired');
      reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });
}
```

- [ ] **Step 4: Wire in `app.ts`** — `await registerAuthRoutes(app);` after `registerCtx(app);`.
- [ ] **Step 5: Run, PASS, commit.**

```bash
npm -w server test
git add . && git commit -m "feat(auth): login, logout, invite/accept routes"
```

### Task 6.2: Super-admin tenants routes (with invite)

**Files:** Create `server/src/repos/users.ts`, `server/src/routes/adminTenants.ts`, `server/test/adminTenants.test.ts`

- [ ] **Step 1: Failing test `server/test/adminTenants.test.ts`**

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createUser } from './helpers/factories.js';

const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
});
let app: Awaited<ReturnType<typeof buildApp>>;
const pool = makePool();

beforeAll(async () => { app = await buildApp({ cfg }); });
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await pool.end(); });

async function loginAs(email: string, password: string) {
  const g = await app.inject({ method: 'GET', url: '/healthz' });
  const cookies = ([] as string[]).concat(g.headers['set-cookie'] as string | string[]);
  const csrf = cookies.find(c => c.startsWith('aip_csrf='))!.split(';')[0];
  const sid  = cookies.find(c => c.startsWith('aip_sid='))!.split(';')[0];
  const csrfVal = decodeURIComponent(csrf.split('=')[1]);
  const headers = { cookie: `${sid}; ${csrf}`, 'x-csrf-token': csrfVal };
  const login = await app.inject({ method: 'POST', url: '/auth/login', headers, payload: { email, password } });
  expect(login.statusCode).toBe(200);
  // Session may have set a new sid cookie
  const newSet = ([] as string[]).concat(login.headers['set-cookie'] as string | string[]).filter(Boolean);
  const newSid = newSet.find(c => c?.startsWith('aip_sid='))?.split(';')[0] ?? sid;
  return { ...headers, cookie: `${newSid}; ${csrf}` };
}

describe('admin tenants', () => {
  it('super_admin creates a tenant + invites first admin', async () => {
    await createUser(pool, { tenantId: null, email: 'root@x.com', password: 'pw12345!', role: 'super_admin' });
    const headers = await loginAs('root@x.com', 'pw12345!');
    const create = await app.inject({
      method: 'POST', url: '/api/admin/tenants', headers,
      payload: { name: 'Acme', slug: 'acme', adminEmail: 'admin@acme.com' },
    });
    expect(create.statusCode).toBe(201);
    const body = create.json();
    expect(body.tenant.slug).toBe('acme');
    expect(body.invite.token).toBeTruthy();
  });

  it('non-super-admin gets 403', async () => {
    const t = await pool.query(`INSERT INTO tenants(name,slug) VALUES ('A','a') RETURNING id`);
    await createUser(pool, { tenantId: t.rows[0].id, email: 'u@a.com', password: 'pw12345!', role: 'tenant_admin' });
    const headers = await loginAs('u@a.com', 'pw12345!');
    const create = await app.inject({
      method: 'POST', url: '/api/admin/tenants', headers,
      payload: { name: 'B', slug: 'b', adminEmail: 'x@b.com' },
    });
    expect(create.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `server/src/repos/users.ts`**

```ts
import type pg from 'pg';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../auth/password.js';
import type { Role } from '@aiployee/shared';

export interface User { id: string; tenant_id: string | null; email: string; role: Role }

export async function createInvitedUser(pool: pg.Pool, input: {
  tenantId: string | null; email: string; role: Role; ttlMinutes?: number;
}): Promise<{ user: User; inviteToken: string }> {
  const token = randomBytes(24).toString('base64url');
  const placeholderHash = await hashPassword(randomBytes(16).toString('hex'));
  const ttl = input.ttlMinutes ?? 60 * 24 * 7;
  const r = await pool.query<User>(
    `INSERT INTO users(tenant_id,email,password_hash,role,invite_token,invite_expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' minutes')::interval)
     RETURNING id, tenant_id, email, role`,
    [input.tenantId, input.email, placeholderHash, input.role, token, String(ttl)],
  );
  return { user: r.rows[0], inviteToken: token };
}

export async function listUsersForTenant(pool: pg.Pool, tenantId: string): Promise<User[]> {
  const r = await pool.query<User>(
    `SELECT id, tenant_id, email, role FROM users WHERE tenant_id = $1 ORDER BY email`, [tenantId]);
  return r.rows;
}
```

- [ ] **Step 4: Implement `server/src/routes/adminTenants.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSuperAdmin } from '../auth/ctx.js';
import { sendError, AppError } from '../util/errors.js';
import { createTenant, listTenants } from '../repos/tenants.js';
import { createInvitedUser } from '../repos/users.js';

const CreateBody = z.object({
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  adminEmail: z.string().email(),
});

export async function registerAdminTenantRoutes(app: FastifyInstance) {
  app.get('/api/admin/tenants', async (req, reply) => {
    try { requireSuperAdmin(req); reply.send({ tenants: await listTenants(app.pool) }); }
    catch (e) { sendError(reply, e); }
  });

  app.post('/api/admin/tenants', async (req, reply) => {
    try {
      requireSuperAdmin(req);
      const body = CreateBody.parse(req.body);
      const tenant = await createTenant(app.pool, { name: body.name, slug: body.slug });
      const invite = await createInvitedUser(app.pool, {
        tenantId: tenant.id, email: body.adminEmail, role: 'tenant_admin',
      });
      reply.code(201).send({
        tenant,
        invite: {
          token: invite.inviteToken,
          url: `${app.cfg.publicBaseUrl}/accept-invite?token=${invite.inviteToken}`,
        },
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return sendError(reply, new AppError('slug_taken', 409, 'Slug already in use'));
      sendError(reply, e);
    }
  });
}
```

- [ ] **Step 5: Wire in `app.ts`** — `await registerAdminTenantRoutes(app);`.
- [ ] **Step 6: Run, PASS, commit.**

```bash
npm -w server test
git add . && git commit -m "feat(admin): create tenant + invite first admin"
```

---

# Phase 7 — SMTP configs

### Task 7.1: SMTP configs repo (with encryption)

**Files:** Create `server/src/repos/smtpConfigs.ts`, `server/test/smtpConfigs.repo.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createSmtpConfig, listSmtpConfigs, getSmtpConfigWithPassword } from '../src/repos/smtpConfigs.js';

const KEY = Buffer.alloc(32, 9);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('smtpConfigs repo', () => {
  it('encrypts password and round-trips', async () => {
    const t = await createTenant(pool);
    const c = await createSmtpConfig(pool, KEY, {
      tenantId: t.id, name: 'SES', host: 'email-smtp.eu-west-1.amazonaws.com',
      port: 587, secure: false, username: 'AKIA', password: 'super-secret',
      fromDomain: 'example.com', isDefault: true,
    });
    expect(c.id).toBeTruthy();
    const list = await listSmtpConfigs(pool, t.id);
    expect(list[0]).not.toHaveProperty('password');
    const full = await getSmtpConfigWithPassword(pool, KEY, t.id, c.id);
    expect(full!.password).toBe('super-secret');
  });

  it('isolates tenants', async () => {
    const a = await createTenant(pool); const b = await createTenant(pool);
    await createSmtpConfig(pool, KEY, {
      tenantId: a.id, name: 'A', host: 'h', port: 25, secure: false,
      username: 'u', password: 'p', fromDomain: 'a.com', isDefault: false,
    });
    expect(await listSmtpConfigs(pool, b.id)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Implement `server/src/repos/smtpConfigs.ts`**

```ts
import type pg from 'pg';
import { encrypt, decrypt } from '../crypto/enc.js';

export interface SmtpConfigRow {
  id: string; tenant_id: string; name: string; host: string; port: number;
  secure: boolean; username: string; from_domain: string; is_default: boolean; created_at: Date;
}

export async function createSmtpConfig(pool: pg.Pool, key: Buffer, input: {
  tenantId: string; name: string; host: string; port: number; secure: boolean;
  username: string; password: string; fromDomain: string; isDefault: boolean;
}): Promise<SmtpConfigRow> {
  const enc = encrypt(input.password, key);
  const r = await pool.query<SmtpConfigRow>(
    `INSERT INTO smtp_configs(tenant_id,name,host,port,secure,username,password_encrypted,from_domain,is_default)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, tenant_id, name, host, port, secure, username, from_domain, is_default, created_at`,
    [input.tenantId, input.name, input.host, input.port, input.secure, input.username, enc, input.fromDomain, input.isDefault],
  );
  return r.rows[0];
}

export async function listSmtpConfigs(pool: pg.Pool, tenantId: string): Promise<SmtpConfigRow[]> {
  const r = await pool.query<SmtpConfigRow>(
    `SELECT id, tenant_id, name, host, port, secure, username, from_domain, is_default, created_at
     FROM smtp_configs WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return r.rows;
}

export async function getSmtpConfigWithPassword(
  pool: pg.Pool, key: Buffer, tenantId: string, id: string,
): Promise<(SmtpConfigRow & { password: string }) | null> {
  const r = await pool.query<SmtpConfigRow & { password_encrypted: Buffer }>(
    `SELECT id, tenant_id, name, host, port, secure, username, from_domain, is_default, created_at, password_encrypted
     FROM smtp_configs WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  const row = r.rows[0];
  if (!row) return null;
  const { password_encrypted, ...rest } = row;
  return { ...rest, password: decrypt(password_encrypted, key) };
}

export async function deleteSmtpConfig(pool: pg.Pool, tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM smtp_configs WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return r.rowCount === 1;
}
```

- [ ] **Step 3: Run, PASS, commit.**

```bash
npm -w server test
git add . && git commit -m "feat(repos): smtpConfigs with encryption + tenant isolation"
```

### Task 7.2: SMTP configs routes (CRUD + test send)

**Files:** Create `server/src/routes/smtpConfigs.ts`, `server/test/smtpConfigs.route.test.ts`. Also create `server/src/send/sender.ts` (transport builder, used here for the test endpoint).

- [ ] **Step 1: Implement `server/src/send/sender.ts`** (used by `/test` endpoint and later by the worker)

```ts
import nodemailer, { type Transporter } from 'nodemailer';
import type { SmtpConfigRow } from '../repos/smtpConfigs.js';

export function buildTransport(cfg: SmtpConfigRow & { password: string }): Transporter {
  return nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: cfg.username, pass: cfg.password },
    pool: false,
  });
}
```

- [ ] **Step 2: Implement `server/src/routes/smtpConfigs.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { sendError, AppError } from '../util/errors.js';
import {
  createSmtpConfig, listSmtpConfigs, getSmtpConfigWithPassword, deleteSmtpConfig,
} from '../repos/smtpConfigs.js';
import { buildTransport } from '../send/sender.js';

const CreateBody = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean().default(false),
  username: z.string().min(1),
  password: z.string().min(1),
  fromDomain: z.string().min(1),
  isDefault: z.boolean().default(false),
});

const TestBody = z.object({ to: z.string().email() });

export async function registerSmtpConfigRoutes(app: FastifyInstance) {
  app.get('/api/smtp-configs', async (req, reply) => {
    try { const ctx = requireTenantCtx(req); reply.send({ configs: await listSmtpConfigs(app.pool, ctx.tenantId) }); }
    catch (e) { sendError(reply, e); }
  });

  app.post('/api/smtp-configs', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const body = CreateBody.parse(req.body);
      const c = await createSmtpConfig(app.pool, app.cfg.encKey, { tenantId: ctx.tenantId, ...body });
      reply.code(201).send({ config: c });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return sendError(reply, new AppError('name_taken', 409, 'Name already in use'));
      sendError(reply, e);
    }
  });

  app.delete('/api/smtp-configs/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const ok = await deleteSmtpConfig(app.pool, ctx.tenantId, id);
      if (!ok) throw new AppError('not_found', 404, 'SMTP config not found');
      reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/smtp-configs/:id/test', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const body = TestBody.parse(req.body);
      const cfg = await getSmtpConfigWithPassword(app.pool, app.cfg.encKey, ctx.tenantId, id);
      if (!cfg) throw new AppError('not_found', 404, 'SMTP config not found');
      const tx = buildTransport(cfg);
      try {
        const info = await tx.sendMail({
          from: `Aiployee Emailer <noreply@${cfg.from_domain}>`,
          to: body.to,
          subject: 'Aiployee Emailer SMTP test',
          text: 'If you can read this, your SMTP config works.',
        });
        reply.send({ ok: true, messageId: info.messageId });
      } finally { tx.close(); }
    } catch (e) {
      sendError(reply, new AppError('smtp_test_failed', 400, (e as Error).message));
    }
  });
}
```

- [ ] **Step 3: Failing route test `server/test/smtpConfigs.route.test.ts`** — exercises GET/POST/DELETE only (test-send needs a mock SMTP, deferred to Plan B).

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createUser, createTenant } from './helpers/factories.js';

const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
});
let app: Awaited<ReturnType<typeof buildApp>>;
const pool = makePool();
beforeAll(async () => { app = await buildApp({ cfg }); });
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await pool.end(); });

async function loginTenantAdmin(tenantId: string, email = 'a@x.com') {
  await createUser(pool, { tenantId, email, password: 'pw12345!', role: 'tenant_admin' });
  const g = await app.inject({ method: 'GET', url: '/healthz' });
  const cookies = ([] as string[]).concat(g.headers['set-cookie'] as string | string[]);
  const csrf = cookies.find(c => c.startsWith('aip_csrf='))!.split(';')[0];
  const sid  = cookies.find(c => c.startsWith('aip_sid='))!.split(';')[0];
  const csrfVal = decodeURIComponent(csrf.split('=')[1]);
  const headers = { cookie: `${sid}; ${csrf}`, 'x-csrf-token': csrfVal };
  await app.inject({ method: 'POST', url: '/auth/login', headers, payload: { email, password: 'pw12345!' } });
  return headers;
}

describe('smtp configs routes', () => {
  it('creates, lists, and isolates by tenant', async () => {
    const a = await createTenant(pool); const b = await createTenant(pool);
    const headersA = await loginTenantAdmin(a.id);
    const create = await app.inject({
      method: 'POST', url: '/api/smtp-configs', headers: headersA,
      payload: { name: 'SES', host: 'h', port: 587, secure: false, username: 'u', password: 'p', fromDomain: 'a.com', isDefault: true },
    });
    expect(create.statusCode).toBe(201);

    const list = await app.inject({ method: 'GET', url: '/api/smtp-configs', headers: headersA });
    expect(list.json().configs).toHaveLength(1);

    const headersB = await loginTenantAdmin(b.id, 'b@x.com');
    const listB = await app.inject({ method: 'GET', url: '/api/smtp-configs', headers: headersB });
    expect(listB.json().configs).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Wire in `app.ts`** — `await registerSmtpConfigRoutes(app);`.
- [ ] **Step 5: Run, PASS, commit.**

```bash
npm -w server test
git add . && git commit -m "feat(api): smtp-configs CRUD + test endpoint"
```

---

# Phase 8 — Senders

### Task 8.1: Senders repo + routes

**Files:** Create `server/src/repos/senders.ts`, `server/src/routes/senders.ts`, `server/test/senders.route.test.ts`

- [ ] **Step 1: `server/src/repos/senders.ts`**

```ts
import type pg from 'pg';

export interface Sender {
  id: string; tenant_id: string; email: string; display_name: string;
  reply_to: string | null; smtp_config_id: string; is_default: boolean; created_at: Date;
}

export async function createSender(pool: pg.Pool, input: {
  tenantId: string; email: string; displayName: string;
  replyTo?: string | null; smtpConfigId: string; isDefault?: boolean;
}): Promise<Sender> {
  const r = await pool.query<Sender>(
    `INSERT INTO senders(tenant_id,email,display_name,reply_to,smtp_config_id,is_default)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, tenant_id, email, display_name, reply_to, smtp_config_id, is_default, created_at`,
    [input.tenantId, input.email, input.displayName, input.replyTo ?? null, input.smtpConfigId, input.isDefault ?? false],
  );
  return r.rows[0];
}

export async function listSenders(pool: pg.Pool, tenantId: string): Promise<Sender[]> {
  const r = await pool.query<Sender>(
    `SELECT id, tenant_id, email, display_name, reply_to, smtp_config_id, is_default, created_at
     FROM senders WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return r.rows;
}

export async function getSenderByEmail(pool: pg.Pool, tenantId: string, email: string): Promise<Sender | null> {
  const r = await pool.query<Sender>(
    `SELECT id, tenant_id, email, display_name, reply_to, smtp_config_id, is_default, created_at
     FROM senders WHERE tenant_id = $1 AND email = $2`, [tenantId, email]);
  return r.rows[0] ?? null;
}

export async function getSenderById(pool: pg.Pool, tenantId: string, id: string): Promise<Sender | null> {
  const r = await pool.query<Sender>(
    `SELECT id, tenant_id, email, display_name, reply_to, smtp_config_id, is_default, created_at
     FROM senders WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return r.rows[0] ?? null;
}

export async function deleteSender(pool: pg.Pool, tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM senders WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return r.rowCount === 1;
}
```

- [ ] **Step 2: `server/src/routes/senders.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { sendError, AppError } from '../util/errors.js';
import { createSender, listSenders, deleteSender } from '../repos/senders.js';

const CreateBody = z.object({
  email: z.string().email(),
  displayName: z.string().min(1),
  replyTo: z.string().email().optional().nullable(),
  smtpConfigId: z.string().uuid(),
  isDefault: z.boolean().default(false),
});

export async function registerSenderRoutes(app: FastifyInstance) {
  app.get('/api/senders', async (req, reply) => {
    try { const ctx = requireTenantCtx(req); reply.send({ senders: await listSenders(app.pool, ctx.tenantId) }); }
    catch (e) { sendError(reply, e); }
  });

  app.post('/api/senders', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const body = CreateBody.parse(req.body);
      // verify smtp config belongs to tenant
      const r = await app.pool.query(
        `SELECT 1 FROM smtp_configs WHERE id = $1 AND tenant_id = $2`,
        [body.smtpConfigId, ctx.tenantId]);
      if (r.rowCount === 0) throw new AppError('invalid_smtp_config', 400, 'SMTP config not found in this tenant');
      const s = await createSender(app.pool, { tenantId: ctx.tenantId, ...body });
      reply.code(201).send({ sender: s });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return sendError(reply, new AppError('email_taken', 409, 'Sender email already exists'));
      sendError(reply, e);
    }
  });

  app.delete('/api/senders/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const ok = await deleteSender(app.pool, ctx.tenantId, id);
      if (!ok) throw new AppError('not_found', 404, 'Sender not found');
      reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });
}
```

- [ ] **Step 3: Failing route test `server/test/senders.route.test.ts`**

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createUser, createTenant } from './helpers/factories.js';
import { createSmtpConfig } from '../src/repos/smtpConfigs.js';

const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
});
let app: Awaited<ReturnType<typeof buildApp>>;
const pool = makePool();
beforeAll(async () => { app = await buildApp({ cfg }); });
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await pool.end(); });

async function loginTenantAdmin(tenantId: string, email = 'a@x.com') {
  await createUser(pool, { tenantId, email, password: 'pw12345!', role: 'tenant_admin' });
  const g = await app.inject({ method: 'GET', url: '/healthz' });
  const cookies = ([] as string[]).concat(g.headers['set-cookie'] as string | string[]);
  const csrf = cookies.find(c => c.startsWith('aip_csrf='))!.split(';')[0];
  const sid  = cookies.find(c => c.startsWith('aip_sid='))!.split(';')[0];
  const csrfVal = decodeURIComponent(csrf.split('=')[1]);
  const headers = { cookie: `${sid}; ${csrf}`, 'x-csrf-token': csrfVal };
  await app.inject({ method: 'POST', url: '/auth/login', headers, payload: { email, password: 'pw12345!' } });
  return headers;
}

describe('senders routes', () => {
  it('creates a sender bound to an SMTP config', async () => {
    const t = await createTenant(pool);
    const headers = await loginTenantAdmin(t.id);
    const sc = await createSmtpConfig(pool, cfg.encKey, {
      tenantId: t.id, name: 'SES', host: 'h', port: 587, secure: false,
      username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
    });
    const r = await app.inject({
      method: 'POST', url: '/api/senders', headers,
      payload: { email: 'alex@x.com', displayName: 'Alex', smtpConfigId: sc.id },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().sender.email).toBe('alex@x.com');
  });

  it('rejects sender bound to another tenant SMTP config', async () => {
    const a = await createTenant(pool); const b = await createTenant(pool);
    const headersA = await loginTenantAdmin(a.id);
    const scB = await createSmtpConfig(pool, cfg.encKey, {
      tenantId: b.id, name: 'SES', host: 'h', port: 587, secure: false,
      username: 'u', password: 'p', fromDomain: 'b.com', isDefault: true,
    });
    const r = await app.inject({
      method: 'POST', url: '/api/senders', headers: headersA,
      payload: { email: 'x@b.com', displayName: 'X', smtpConfigId: scB.id },
    });
    expect(r.statusCode).toBe(400);
  });
});
```

- [ ] **Step 4: Wire in `app.ts`** — `await registerSenderRoutes(app);`.
- [ ] **Step 5: Run, PASS, commit.**

```bash
npm -w server test
git add . && git commit -m "feat(api): senders CRUD with cross-tenant SMTP guard"
```

---

# Phase 9 — Templates

### Task 9.1: Templates repo + variable extraction

**Files:** Create `server/src/repos/templates.ts`, `server/src/send/render.ts`, `server/test/templates.repo.test.ts`, `server/test/render.test.ts`

- [ ] **Step 1: Failing test `server/test/render.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { extractVariables, render } from '../src/send/render.js';

describe('render', () => {
  it('extracts unique variable names', () => {
    expect(extractVariables('Hi {{name}}, your code is {{code}}. {{name}} again.')).toEqual(['name', 'code']);
  });
  it('substitutes variables', () => {
    expect(render('Hi {{name}}', { name: 'Alex' })).toBe('Hi Alex');
  });
  it('throws on missing variables', () => {
    expect(() => render('Hi {{name}}', {})).toThrow(/missing/i);
  });
  it('html-escapes by default', () => {
    expect(render('<p>{{x}}</p>', { x: '<script>' })).toBe('<p>&lt;script&gt;</p>');
  });
});
```

- [ ] **Step 2: Implement `server/src/send/render.ts`**

```ts
const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export function extractVariables(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(VAR_RE)) seen.add(m[1]);
  return [...seen];
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export function render(template: string, vars: Record<string, string>, opts: { escape?: boolean } = {}): string {
  const escape = opts.escape !== false;
  return template.replace(VAR_RE, (_m, name: string) => {
    if (!(name in vars)) throw new Error(`missing variable: ${name}`);
    const v = String(vars[name]);
    return escape ? escapeHtml(v) : v;
  });
}
```

- [ ] **Step 3: Implement `server/src/repos/templates.ts`**

```ts
import type pg from 'pg';
import { extractVariables } from '../send/render.js';

export interface Template {
  id: string; tenant_id: string; name: string; subject: string;
  body_html: string; body_text: string | null; variables: string[];
  created_at: Date; updated_at: Date;
}

function vars(input: { subject: string; bodyHtml: string; bodyText?: string | null }): string[] {
  const set = new Set<string>([
    ...extractVariables(input.subject),
    ...extractVariables(input.bodyHtml),
    ...(input.bodyText ? extractVariables(input.bodyText) : []),
  ]);
  return [...set];
}

export async function createTemplate(pool: pg.Pool, input: {
  tenantId: string; name: string; subject: string; bodyHtml: string; bodyText?: string | null;
}): Promise<Template> {
  const v = vars(input);
  const r = await pool.query<Template>(
    `INSERT INTO templates(tenant_id,name,subject,body_html,body_text,variables)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     RETURNING id, tenant_id, name, subject, body_html, body_text, variables, created_at, updated_at`,
    [input.tenantId, input.name, input.subject, input.bodyHtml, input.bodyText ?? null, JSON.stringify(v)],
  );
  return r.rows[0];
}

export async function updateTemplate(pool: pg.Pool, tenantId: string, id: string, input: {
  name?: string; subject?: string; bodyHtml?: string; bodyText?: string | null;
}): Promise<Template | null> {
  const existing = await getTemplateById(pool, tenantId, id);
  if (!existing) return null;
  const merged = {
    name: input.name ?? existing.name,
    subject: input.subject ?? existing.subject,
    bodyHtml: input.bodyHtml ?? existing.body_html,
    bodyText: input.bodyText !== undefined ? input.bodyText : existing.body_text,
  };
  const v = vars({ subject: merged.subject, bodyHtml: merged.bodyHtml, bodyText: merged.bodyText });
  const r = await pool.query<Template>(
    `UPDATE templates SET name=$3, subject=$4, body_html=$5, body_text=$6, variables=$7::jsonb, updated_at=now()
     WHERE tenant_id=$1 AND id=$2
     RETURNING id, tenant_id, name, subject, body_html, body_text, variables, created_at, updated_at`,
    [tenantId, id, merged.name, merged.subject, merged.bodyHtml, merged.bodyText, JSON.stringify(v)],
  );
  return r.rows[0] ?? null;
}

export async function listTemplates(pool: pg.Pool, tenantId: string): Promise<Template[]> {
  const r = await pool.query<Template>(
    `SELECT id, tenant_id, name, subject, body_html, body_text, variables, created_at, updated_at
     FROM templates WHERE tenant_id = $1 ORDER BY name`, [tenantId]);
  return r.rows;
}

export async function getTemplateById(pool: pg.Pool, tenantId: string, id: string): Promise<Template | null> {
  const r = await pool.query<Template>(
    `SELECT id, tenant_id, name, subject, body_html, body_text, variables, created_at, updated_at
     FROM templates WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return r.rows[0] ?? null;
}

export async function getTemplateByName(pool: pg.Pool, tenantId: string, name: string): Promise<Template | null> {
  const r = await pool.query<Template>(
    `SELECT id, tenant_id, name, subject, body_html, body_text, variables, created_at, updated_at
     FROM templates WHERE tenant_id = $1 AND name = $2`, [tenantId, name]);
  return r.rows[0] ?? null;
}

export async function deleteTemplate(pool: pg.Pool, tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM templates WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return r.rowCount === 1;
}
```

- [ ] **Step 4: Repo test `server/test/templates.repo.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createTemplate, updateTemplate, listTemplates } from '../src/repos/templates.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('templates repo', () => {
  it('extracts variables on create', async () => {
    const t = await createTenant(pool);
    const tpl = await createTemplate(pool, {
      tenantId: t.id, name: 'welcome',
      subject: 'Hi {{name}}', bodyHtml: '<p>Hello {{name}} from {{company}}</p>',
    });
    expect(tpl.variables.sort()).toEqual(['company', 'name']);
  });

  it('re-extracts variables on update', async () => {
    const t = await createTenant(pool);
    const tpl = await createTemplate(pool, {
      tenantId: t.id, name: 'x', subject: 's', bodyHtml: '<p>{{a}}</p>',
    });
    const upd = await updateTemplate(pool, t.id, tpl.id, { bodyHtml: '<p>{{b}}</p>' });
    expect(upd!.variables).toEqual(['b']);
  });
});
```

- [ ] **Step 5: Run, PASS, commit.**

```bash
npm -w server test
git add . && git commit -m "feat(repos+send): templates repo with variable extraction + render"
```

### Task 9.2: Templates routes (CRUD + preview render)

**Files:** Create `server/src/routes/templates.ts`, `server/test/templates.route.test.ts`

- [ ] **Step 1: Implement `server/src/routes/templates.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { sendError, AppError } from '../util/errors.js';
import {
  createTemplate, updateTemplate, listTemplates, getTemplateById, deleteTemplate,
} from '../repos/templates.js';
import { render } from '../send/render.js';

const CreateBody = z.object({
  name: z.string().min(1).regex(/^[a-z0-9_-]+$/),
  subject: z.string().min(1),
  bodyHtml: z.string().min(1),
  bodyText: z.string().optional().nullable(),
});

const UpdateBody = z.object({
  name: z.string().min(1).regex(/^[a-z0-9_-]+$/).optional(),
  subject: z.string().min(1).optional(),
  bodyHtml: z.string().min(1).optional(),
  bodyText: z.string().nullable().optional(),
});

const PreviewBody = z.object({ variables: z.record(z.string(), z.string()) });

export async function registerTemplateRoutes(app: FastifyInstance) {
  app.get('/api/templates', async (req, reply) => {
    try { const ctx = requireTenantCtx(req); reply.send({ templates: await listTemplates(app.pool, ctx.tenantId) }); }
    catch (e) { sendError(reply, e); }
  });

  app.post('/api/templates', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const body = CreateBody.parse(req.body);
      const t = await createTemplate(app.pool, { tenantId: ctx.tenantId, ...body });
      reply.code(201).send({ template: t });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return sendError(reply, new AppError('name_taken', 409, 'Template name already exists'));
      sendError(reply, e);
    }
  });

  app.patch('/api/templates/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const body = UpdateBody.parse(req.body);
      const { id } = req.params as { id: string };
      const t = await updateTemplate(app.pool, ctx.tenantId, id, body);
      if (!t) throw new AppError('not_found', 404, 'Template not found');
      reply.send({ template: t });
    } catch (e) { sendError(reply, e); }
  });

  app.delete('/api/templates/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const ok = await deleteTemplate(app.pool, ctx.tenantId, id);
      if (!ok) throw new AppError('not_found', 404, 'Template not found');
      reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/templates/:id/preview', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const body = PreviewBody.parse(req.body);
      const t = await getTemplateById(app.pool, ctx.tenantId, id);
      if (!t) throw new AppError('not_found', 404, 'Template not found');
      reply.send({
        subject: render(t.subject, body.variables, { escape: false }),
        html: render(t.body_html, body.variables),
        text: t.body_text ? render(t.body_text, body.variables, { escape: false }) : null,
      });
    } catch (e) { sendError(reply, new AppError('render_failed', 400, (e as Error).message)); }
  });
}
```

- [ ] **Step 2: Wire in `app.ts`** — `await registerTemplateRoutes(app);`. Write a route test mirroring the senders test (auth, create, list, isolation).
- [ ] **Step 3: Run, PASS, commit.**

```bash
npm -w server test
git add . && git commit -m "feat(api): templates CRUD + preview render"
```

---

# Phase 10 — API keys

### Task 10.1: API keys repo + routes

**Files:** Create `server/src/repos/apiKeys.ts`, `server/src/routes/apiKeys.ts`, `server/test/apiKeys.route.test.ts`

- [ ] **Step 1: `server/src/repos/apiKeys.ts`**

```ts
import type pg from 'pg';

export interface ApiKeyRow {
  id: string; tenant_id: string; name: string; key_prefix: string;
  created_at: Date; last_used_at: Date | null; revoked_at: Date | null;
}

export async function insertApiKey(pool: pg.Pool, input: {
  tenantId: string; name: string; keyHash: string; keyPrefix: string;
}): Promise<ApiKeyRow> {
  const r = await pool.query<ApiKeyRow>(
    `INSERT INTO api_keys(tenant_id,name,key_hash,key_prefix)
     VALUES ($1,$2,$3,$4)
     RETURNING id, tenant_id, name, key_prefix, created_at, last_used_at, revoked_at`,
    [input.tenantId, input.name, input.keyHash, input.keyPrefix]);
  return r.rows[0];
}

export async function listApiKeys(pool: pg.Pool, tenantId: string): Promise<ApiKeyRow[]> {
  const r = await pool.query<ApiKeyRow>(
    `SELECT id, tenant_id, name, key_prefix, created_at, last_used_at, revoked_at
     FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return r.rows;
}

export async function revokeApiKey(pool: pg.Pool, tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE api_keys SET revoked_at = now() WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL`,
    [tenantId, id]);
  return r.rowCount === 1;
}
```

- [ ] **Step 2: `server/src/routes/apiKeys.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { sendError, AppError } from '../util/errors.js';
import { generateApiKey, hashApiKey, prefixOf } from '../auth/apiKey.js';
import { insertApiKey, listApiKeys, revokeApiKey } from '../repos/apiKeys.js';

const CreateBody = z.object({ name: z.string().min(1) });

export async function registerApiKeyRoutes(app: FastifyInstance) {
  app.get('/api/api-keys', async (req, reply) => {
    try { const ctx = requireTenantCtx(req); reply.send({ keys: await listApiKeys(app.pool, ctx.tenantId) }); }
    catch (e) { sendError(reply, e); }
  });

  app.post('/api/api-keys', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const body = CreateBody.parse(req.body);
      const plaintext = generateApiKey();
      const row = await insertApiKey(app.pool, {
        tenantId: ctx.tenantId, name: body.name,
        keyHash: hashApiKey(plaintext), keyPrefix: prefixOf(plaintext),
      });
      reply.code(201).send({ key: row, plaintext });
    } catch (e) { sendError(reply, e); }
  });

  app.delete('/api/api-keys/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const ok = await revokeApiKey(app.pool, ctx.tenantId, id);
      if (!ok) throw new AppError('not_found', 404, 'API key not found or already revoked');
      reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });
}
```

- [ ] **Step 3: Test `server/test/apiKeys.route.test.ts`** — login as tenant_admin, POST /api/api-keys, assert plaintext starts with `aip_live_`, list returns prefix only, DELETE marks revoked.

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createUser, createTenant } from './helpers/factories.js';

const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
});
let app: Awaited<ReturnType<typeof buildApp>>;
const pool = makePool();
beforeAll(async () => { app = await buildApp({ cfg }); });
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await pool.end(); });

async function loginTenantAdmin(tenantId: string) {
  await createUser(pool, { tenantId, email: 'a@x.com', password: 'pw12345!', role: 'tenant_admin' });
  const g = await app.inject({ method: 'GET', url: '/healthz' });
  const cookies = ([] as string[]).concat(g.headers['set-cookie'] as string | string[]);
  const csrf = cookies.find(c => c.startsWith('aip_csrf='))!.split(';')[0];
  const sid  = cookies.find(c => c.startsWith('aip_sid='))!.split(';')[0];
  const csrfVal = decodeURIComponent(csrf.split('=')[1]);
  const headers = { cookie: `${sid}; ${csrf}`, 'x-csrf-token': csrfVal };
  await app.inject({ method: 'POST', url: '/auth/login', headers, payload: { email: 'a@x.com', password: 'pw12345!' } });
  return headers;
}

describe('api keys routes', () => {
  it('creates, lists (no plaintext), and revokes', async () => {
    const t = await createTenant(pool);
    const headers = await loginTenantAdmin(t.id);
    const create = await app.inject({
      method: 'POST', url: '/api/api-keys', headers, payload: { name: 'workflow-1' },
    });
    expect(create.statusCode).toBe(201);
    const body = create.json();
    expect(body.plaintext.startsWith('aip_live_')).toBe(true);
    expect(body.key.key_prefix).toBe(body.plaintext.slice(0, 13));

    const list = await app.inject({ method: 'GET', url: '/api/api-keys', headers });
    expect(list.json().keys[0]).not.toHaveProperty('key_hash');

    const id = body.key.id;
    const del = await app.inject({ method: 'DELETE', url: `/api/api-keys/${id}`, headers });
    expect(del.statusCode).toBe(200);
    const list2 = await app.inject({ method: 'GET', url: '/api/api-keys', headers });
    expect(list2.json().keys[0].revoked_at).toBeTruthy();
  });
});
```

- [ ] **Step 4: Wire in `app.ts`** — `await registerApiKeyRoutes(app);`.
- [ ] **Step 5: Run, PASS, commit.**

```bash
npm -w server test
git add . && git commit -m "feat(api): api-keys CRUD with plaintext-on-create"
```

---

## Plan A — Self-review

- **Spec coverage (this plan only):** Foundation, schema, crypto, auth, tenant ctx, super-admin tenants, SMTP configs, senders, templates, api keys are all covered. Sending pipeline / scheduled / bounces are deferred to Plan B. UI / Docker / acceptance are deferred to Plan C. Plan A is testable end-to-end via curl / inject.
- **Type consistency:** `Ctx`, `Tenant`, `Sender`, `Template`, `SmtpConfigRow`, `ApiKeyRow` are defined once and reused. `Role` comes from `@aiployee/shared`.
- **Placeholders:** none.

## Acceptance for Plan A

Before starting Plan B, all of the following must hold:

1. `npm -w server test` — all green.
2. `npm -w server run dev` boots and `/healthz` returns `200`.
3. Manual curl: POST `/auth/login` as super-admin → POST `/api/admin/tenants` → use returned invite URL token in POST `/auth/invite/accept` → log in as new tenant_admin → POST `/api/smtp-configs`, `/api/senders`, `/api/templates`, `/api/api-keys` succeed.
4. Cross-tenant isolation: a tenant_admin in tenant A cannot list or modify any resource of tenant B.
