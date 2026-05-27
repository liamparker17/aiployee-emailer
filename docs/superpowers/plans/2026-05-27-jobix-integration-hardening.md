# Jobix Integration Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `POST /v1/emails` safe and easy to drive from a Jobix custom-integration webhook — flexible API-key headers, dual-mode idempotency, optional per-key sender binding, and a stable error model — without changing the existing send core.

**Architecture:** Additive changes around the existing Fastify route → `queueEmail` → dispatch pipeline. One additive DB migration adds idempotency columns to `emails` and a nullable `sender_id` to `api_keys`. Auth (`ctx.ts`) gains multi-header key resolution and surfaces the key's bound sender. The `POST /v1/emails` route gains idempotency lookups and sender-binding enforcement. All current callers (Bearer auth, tenant-wide keys) keep working unchanged.

**Tech Stack:** Node 24, Fastify 5, Zod 3, Postgres (pg), node-pg-migrate, Vitest. Public API fields are snake_case.

**Reference spec:** `docs/superpowers/specs/2026-05-27-jobix-integration-go-live-design.md`
**Jobix field reference:** `payload-fields.md`

---

## Preconditions (run once before starting)

A local Postgres must be running and the **test** database migrated. The test config
(`server/test/v1Emails.test.ts`) uses `TEST_DATABASE_URL` or falls back to
`postgres://emailer:emailer@localhost:5433/emailer`.

```bash
docker compose -f docker/docker-compose.dev.yml up -d
# bash:
DATABASE_URL=postgres://emailer:emailer@localhost:5433/emailer npm -w server run migrate
# PowerShell:
#   $env:DATABASE_URL='postgres://emailer:emailer@localhost:5433/emailer'; npm -w server run migrate
```

Confirm the baseline is green before changing anything:

```bash
npm -w server test
```
Expected: all suites pass. If `v1Emails.test.ts` asserts a `queued` status that no longer
matches inline-send behavior, note it — Task 5/6 tests assert on row identity/counts (timing-robust)
rather than `queued` vs `sent`, so they hold either way.

---

## File Structure

- **Create** `server/migrations/1700000000006_idempotency_and_key_sender.cjs` — additive migration.
- **Create** `server/src/send/dedupe.ts` — pure content-hash helper.
- **Modify** `server/src/repos/emails.ts` — `insertEmail` gains idempotency fields; add two lookup fns.
- **Modify** `server/src/repos/apiKeys.ts` — `ApiKeyRow.sender_id`; `insertApiKey` gains `senderId`.
- **Modify** `server/src/auth/ctx.ts` — multi-header key resolution; `Ctx.boundSenderId`.
- **Modify** `server/src/send/pipeline.ts` — `queueEmail` forwards idempotency fields to `insertEmail`.
- **Modify** `server/src/routes/v1Emails.ts` — idempotency lookup, sender-binding, error mapping.
- **Modify** `server/src/routes/apiKeys.ts` — accept + validate optional `senderId` on create.
- **Modify** `web/src/pages/ApiKeys.tsx` — "Restrict to sender" dropdown.
- **Tests:** extend `server/test/emails.repo.test.ts`, `apiKeys.route.test.ts`, `v1Emails.test.ts`.

---

## Task 1: Migration — idempotency columns + api_keys.sender_id

**Files:**
- Create: `server/migrations/1700000000006_idempotency_and_key_sender.cjs`

- [ ] **Step 1: Write the migration**

```js
/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.addColumns('emails', {
    idempotency_key: { type: 'text', notNull: false },
    dedupe_hash:     { type: 'text', notNull: false },
  });
  pgm.createIndex('emails', ['tenant_id', 'idempotency_key'], {
    unique: true,
    name: 'emails_tenant_idempotency_key_uniq',
    where: 'idempotency_key IS NOT NULL',
  });
  pgm.createIndex('emails', ['tenant_id', 'dedupe_hash', 'created_at'], {
    name: 'emails_tenant_dedupe_hash_idx',
    where: 'dedupe_hash IS NOT NULL',
  });
  pgm.addColumn('api_keys', {
    sender_id: { type: 'uuid', notNull: false, references: 'senders', onDelete: 'RESTRICT' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('api_keys', 'sender_id');
  pgm.dropIndex('emails', ['tenant_id', 'dedupe_hash', 'created_at'], { name: 'emails_tenant_dedupe_hash_idx' });
  pgm.dropIndex('emails', ['tenant_id', 'idempotency_key'], { name: 'emails_tenant_idempotency_key_uniq' });
  pgm.dropColumns('emails', ['idempotency_key', 'dedupe_hash']);
};
```

- [ ] **Step 2: Apply to the test DB and verify it runs clean**

Run (bash):
```bash
DATABASE_URL=postgres://emailer:emailer@localhost:5433/emailer npm -w server run migrate
```
Expected: `Migrating files: > 1700000000006_idempotency_and_key_sender` then `Migrations complete!`

- [ ] **Step 3: Verify down works, then re-up**

```bash
DATABASE_URL=postgres://emailer:emailer@localhost:5433/emailer npm -w server run migrate:down
DATABASE_URL=postgres://emailer:emailer@localhost:5433/emailer npm -w server run migrate
```
Expected: down removes the migration, up re-applies cleanly.

- [ ] **Step 4: Commit**

```bash
git add server/migrations/1700000000006_idempotency_and_key_sender.cjs
git commit -m "feat(db): add email idempotency columns and api_keys.sender_id"
```

---

## Task 2: emails repo — idempotency persistence + lookups

**Files:**
- Modify: `server/src/repos/emails.ts`
- Test: `server/test/emails.repo.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `server/test/emails.repo.test.ts` (reuse its existing imports/setup for `pool`,
`truncateAll`, and a tenant+sender factory — mirror the patterns already in that file):

```ts
import { insertEmail, findEmailByIdempotencyKey, findRecentByDedupeHash } from '../src/repos/emails.js';

it('finds an email by idempotency key (tenant-scoped)', async () => {
  const { tenantId, senderId } = await seedTenantSender(); // existing helper in this file
  const e = await insertEmail(pool, {
    tenantId, senderId, toAddr: 'r@x.com', subject: 'S', bodyHtml: '<p>h</p>',
    idempotencyKey: 'idem-1',
  });
  expect((await findEmailByIdempotencyKey(pool, tenantId, 'idem-1'))?.id).toBe(e.id);
  expect(await findEmailByIdempotencyKey(pool, tenantId, 'nope')).toBeNull();
  expect(await findEmailByIdempotencyKey(pool, 'other-tenant', 'idem-1')).toBeNull();
});

it('finds a recent email by dedupe hash within the window only', async () => {
  const { tenantId, senderId } = await seedTenantSender();
  const e = await insertEmail(pool, {
    tenantId, senderId, toAddr: 'r@x.com', subject: 'S', bodyHtml: '<p>h</p>',
    dedupeHash: 'hash-1',
  });
  expect((await findRecentByDedupeHash(pool, tenantId, 'hash-1', 10))?.id).toBe(e.id);
  // window of 0 minutes => nothing counts as recent
  expect(await findRecentByDedupeHash(pool, tenantId, 'hash-1', 0)).toBeNull();
});
```

> If `emails.repo.test.ts` has no `seedTenantSender` helper, add a small one at the top of the file
> using `createTenant` (from `./helpers/factories.js`) + `createSender` (from `../src/repos/senders.js`)
> + `createSmtpConfig` (from `../src/repos/smtpConfigs.js`), matching the factory usage in
> `v1Emails.test.ts` lines 33-42.

- [ ] **Step 2: Run to verify failure**

Run: `npm -w server test -- emails.repo`
Expected: FAIL — `findEmailByIdempotencyKey is not a function` / TS error on unknown `insertEmail` fields.

- [ ] **Step 3: Implement**

In `server/src/repos/emails.ts`, extend the `insertEmail` input type and SQL:

```ts
export async function insertEmail(pool: pg.Pool, input: {
  tenantId: string; senderId: string; toAddr: string; cc?: string[]; bcc?: string[];
  replyTo?: string | null; subject: string; bodyHtml: string; bodyText?: string | null;
  templateId?: string | null; attachments?: unknown[]; scheduledFor?: Date | null;
  apiKeyId?: string | null; status?: EmailStatus;
  idempotencyKey?: string | null; dedupeHash?: string | null;
}): Promise<EmailRow> {
  const r = await pool.query<EmailRow>(
    `INSERT INTO emails(tenant_id, sender_id, to_addr, cc, bcc, reply_to,
                         subject, body_html, body_text, template_id, attachments,
                         status, scheduled_for, api_key_id, idempotency_key, dedupe_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16)
     RETURNING ${SELECT}`,
    [
      input.tenantId, input.senderId, input.toAddr,
      input.cc ?? [], input.bcc ?? [], input.replyTo ?? null,
      input.subject, input.bodyHtml, input.bodyText ?? null,
      input.templateId ?? null, JSON.stringify(input.attachments ?? []),
      input.status ?? 'queued', input.scheduledFor ?? null, input.apiKeyId ?? null,
      input.idempotencyKey ?? null, input.dedupeHash ?? null,
    ],
  );
  return r.rows[0];
}

export async function findEmailByIdempotencyKey(
  pool: pg.Pool, tenantId: string, key: string,
): Promise<EmailRow | null> {
  const r = await pool.query<EmailRow>(
    `SELECT ${SELECT} FROM emails WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1`,
    [tenantId, key]);
  return r.rows[0] ?? null;
}

export async function findRecentByDedupeHash(
  pool: pg.Pool, tenantId: string, hash: string, windowMin: number,
): Promise<EmailRow | null> {
  const r = await pool.query<EmailRow>(
    `SELECT ${SELECT} FROM emails
     WHERE tenant_id = $1 AND dedupe_hash = $2
       AND created_at > now() - ($3 || ' minutes')::interval
     ORDER BY created_at DESC LIMIT 1`,
    [tenantId, hash, String(windowMin)]);
  return r.rows[0] ?? null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm -w server test -- emails.repo`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/repos/emails.ts server/test/emails.repo.test.ts
git commit -m "feat(emails): persist idempotency_key/dedupe_hash + lookup helpers"
```

---

## Task 3: api_keys repo + create-route — optional sender binding

**Files:**
- Modify: `server/src/repos/apiKeys.ts`
- Modify: `server/src/routes/apiKeys.ts`
- Test: `server/test/apiKeys.route.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `server/test/apiKeys.route.test.ts` (reuse its session/login helper and tenant factory):

```ts
it('creates a key bound to a sender', async () => {
  const { sessionCookie, tenantId, senderId } = await loginTenantWithSender(); // see note below
  const r = await app.inject({
    method: 'POST', url: '/api/api-keys',
    headers: { cookie: sessionCookie },
    payload: { name: 'bound', senderId },
  });
  expect(r.statusCode).toBe(201);
  expect((r.json() as { key: { sender_id: string } }).key.sender_id).toBe(senderId);
});

it('rejects a senderId from another tenant', async () => {
  const { sessionCookie } = await loginTenantWithSender();
  const r = await app.inject({
    method: 'POST', url: '/api/api-keys',
    headers: { cookie: sessionCookie },
    payload: { name: 'bad', senderId: '00000000-0000-0000-0000-000000000000' },
  });
  expect(r.statusCode).toBe(400);
  expect((r.json() as { error: { code: string } }).error.code).toBe('invalid_sender');
});
```

> Mirror the existing login/setup helper already used in `apiKeys.route.test.ts`. If a sender isn't
> created there, add one via `createSmtpConfig` + `createSender` (same as `v1Emails.test.ts:35-39`)
> and return its id as `senderId`.

- [ ] **Step 2: Run to verify failure**

Run: `npm -w server test -- apiKeys.route`
Expected: FAIL — `sender_id` undefined on the returned key / 201 vs expected validation.

- [ ] **Step 3: Implement repo change** (`server/src/repos/apiKeys.ts`)

```ts
export interface ApiKeyRow {
  id: string; tenant_id: string; name: string; key_prefix: string;
  sender_id: string | null;
  created_at: Date; last_used_at: Date | null; revoked_at: Date | null;
}

export async function insertApiKey(pool: pg.Pool, input: {
  tenantId: string; name: string; keyHash: string; keyPrefix: string;
  senderId?: string | null;
}): Promise<ApiKeyRow> {
  const r = await pool.query<ApiKeyRow>(
    `INSERT INTO api_keys(tenant_id,name,key_hash,key_prefix,sender_id)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id, tenant_id, name, key_prefix, sender_id, created_at, last_used_at, revoked_at`,
    [input.tenantId, input.name, input.keyHash, input.keyPrefix, input.senderId ?? null]);
  return r.rows[0];
}

export async function listApiKeys(pool: pg.Pool, tenantId: string): Promise<ApiKeyRow[]> {
  const r = await pool.query<ApiKeyRow>(
    `SELECT id, tenant_id, name, key_prefix, sender_id, created_at, last_used_at, revoked_at
     FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return r.rows;
}
```
(`revokeApiKey` is unchanged.)

- [ ] **Step 4: Implement route change** (`server/src/routes/apiKeys.ts`)

Add the import and update `CreateBody` + the POST handler:

```ts
import { getSenderById } from '../repos/senders.js';

const CreateBody = z.object({
  name: z.string().min(1),
  senderId: z.string().uuid().optional(),
});
```

```ts
  app.post('/api/api-keys', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const body = CreateBody.parse(req.body);
      if (body.senderId) {
        const sender = await getSenderById(app.pool, ctx.tenantId, body.senderId);
        if (!sender) throw new AppError('invalid_sender', 400, 'Sender not found for this tenant');
      }
      const plaintext = generateApiKey();
      const row = await insertApiKey(app.pool, {
        tenantId: ctx.tenantId, name: body.name,
        keyHash: hashApiKey(plaintext), keyPrefix: prefixOf(plaintext),
        senderId: body.senderId ?? null,
      });
      reply.code(201).send({ key: row, plaintext });
    } catch (e) { sendError(reply, e); }
  });
```

- [ ] **Step 5: Run to verify pass**

Run: `npm -w server test -- apiKeys.route`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/repos/apiKeys.ts server/src/routes/apiKeys.ts server/test/apiKeys.route.test.ts
git commit -m "feat(api-keys): optional sender binding on key creation"
```

---

## Task 4: Flexible API-key header resolution + boundSenderId in ctx

**Files:**
- Modify: `server/src/auth/ctx.ts`
- Test: `server/test/v1Emails.test.ts`

- [ ] **Step 1: Write failing tests**

Add to the `describe('POST /v1/emails')` block in `server/test/v1Emails.test.ts`:

```ts
it.each([
  ['api_key', (k: string) => ({ api_key: k })],
  ['x-api-key', (k: string) => ({ 'x-api-key': k })],
  ['authorization bearer', (k: string) => ({ authorization: `Bearer ${k}` })],
])('authenticates via %s header', async (_label, hdr) => {
  const { s, key } = await setup();
  const r = await app.inject({
    method: 'POST', url: '/v1/emails',
    headers: hdr(key),
    payload: { from: s.email, to: 'r@x.com', subject: 'Hi', html: '<p>x</p>' },
  });
  expect(r.statusCode).toBe(202);
});

it('rejects an unknown api_key header value', async () => {
  await setup();
  const r = await app.inject({
    method: 'POST', url: '/v1/emails',
    headers: { api_key: 'aip_live_bogus' },
    payload: { from: 'a@x.com', to: 'r@x.com', subject: 'Hi', html: '<p>x</p>' },
  });
  expect(r.statusCode).toBe(401);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm -w server test -- v1Emails`
Expected: FAIL — `api_key` / `x-api-key` variants return 401 (only Bearer works today).

- [ ] **Step 3: Implement** (`server/src/auth/ctx.ts`)

Extend `Ctx`:

```ts
export interface Ctx {
  tenantId: string;
  userId?: string;
  apiKeyId?: string;
  boundSenderId?: string | null;
  role: 'super_admin' | 'tenant_admin' | 'tenant_user' | 'api_key';
}
```

Replace the `/v1/` auth block inside `registerCtx`:

```ts
    if (req.url.startsWith('/v1/')) {
      const h = req.headers;
      const raw =
        (typeof h['api_key'] === 'string' && h['api_key']) ||
        (typeof h['x-api-key'] === 'string' && h['x-api-key']) ||
        (h.authorization?.startsWith('Bearer ') ? h.authorization.slice(7) : '');
      const key = (raw || '').trim();
      if (!key) {
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'Missing API key' } });
      }
      const hash = hashApiKey(key);
      const r = await app.pool.query<{ id: string; tenant_id: string; sender_id: string | null }>(
        `UPDATE api_keys SET last_used_at = now()
         WHERE key_hash = $1 AND revoked_at IS NULL
         RETURNING id, tenant_id, sender_id`, [hash]);
      if (r.rowCount === 0) {
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'Invalid API key' } });
      }
      req.ctx = {
        tenantId: r.rows[0].tenant_id, apiKeyId: r.rows[0].id,
        boundSenderId: r.rows[0].sender_id, role: 'api_key',
      };
      return;
    }
```

(The webhook/cron/healthz early-return and the `/api/` + `/auth/` session block are unchanged.
Never log `raw`/`key`.)

- [ ] **Step 4: Run to verify pass**

Run: `npm -w server test -- v1Emails`
Expected: the three header variants PASS; the bogus-key test PASSES (401).

- [ ] **Step 5: Commit**

```bash
git add server/src/auth/ctx.ts server/test/v1Emails.test.ts
git commit -m "feat(auth): accept api_key/X-Api-Key headers and surface boundSenderId"
```

---

## Task 5: Sender-binding enforcement + error mapping on the send route

**Files:**
- Modify: `server/src/send/pipeline.ts`
- Modify: `server/src/routes/v1Emails.ts`
- Test: `server/test/v1Emails.test.ts`

- [ ] **Step 1: Write failing tests**

Add a bound-key helper and tests to `server/test/v1Emails.test.ts`:

```ts
import { getSenderById } from '../src/repos/senders.js';

async function setupBound() {
  const t = await createTenant(pool);
  const sc = await createSmtpConfig(pool, KEY, {
    tenantId: t.id, name: 'local', host: '127.0.0.1', port: 2527, secure: false,
    username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
  });
  const s = await createSender(pool, { tenantId: t.id, email: 'bound@x.com', displayName: 'B', smtpConfigId: sc.id });
  const key = generateApiKey();
  await insertApiKey(pool, {
    tenantId: t.id, name: 'bk', keyHash: hashApiKey(key), keyPrefix: prefixOf(key), senderId: s.id,
  });
  return { t, s, key };
}

it('bound key rejects a foreign from with 422 invalid_sender', async () => {
  const { key } = await setupBound();
  const r = await app.inject({
    method: 'POST', url: '/v1/emails', headers: { api_key: key },
    payload: { from: 'someone-else@x.com', to: 'r@x.com', subject: 'Hi', html: '<p>x</p>' },
  });
  expect(r.statusCode).toBe(422);
  expect((r.json() as { error: { code: string } }).error.code).toBe('invalid_sender');
});

it('bound key defaults from to the bound sender when omitted', async () => {
  const { t, s, key } = await setupBound();
  const r = await app.inject({
    method: 'POST', url: '/v1/emails', headers: { api_key: key },
    payload: { to: 'r@x.com', subject: 'Hi', html: '<p>x</p>' },
  });
  expect(r.statusCode).toBe(202);
  const id = (r.json() as { id: string }).id;
  const row = await getEmail(pool, t.id, id);
  expect(row!.sender_id).toBe(s.id);
});

it('tenant-wide key with unknown from returns 422 invalid_sender', async () => {
  const { key } = await setup();
  const r = await app.inject({
    method: 'POST', url: '/v1/emails', headers: { api_key: key },
    payload: { from: 'ghost@x.com', to: 'r@x.com', subject: 'Hi', html: '<p>x</p>' },
  });
  expect(r.statusCode).toBe(422);
  expect((r.json() as { error: { code: string } }).error.code).toBe('invalid_sender');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm -w server test -- v1Emails`
Expected: FAIL — omitted `from` fails schema; mismatched `from` returns 400 not 422.

- [ ] **Step 3: Implement pipeline error-code change** (`server/src/send/pipeline.ts`)

Change the invalid-sender status from 400 to 422:

```ts
  if (!sender) throw new AppError('invalid_sender', 422, `Sender not found: ${input.from}`);
```

- [ ] **Step 4: Implement route changes** (`server/src/routes/v1Emails.ts`)

Make `from` optional in the API body and enforce binding before queueing. Replace the top of the
file's body schema and the start of the POST handler:

```ts
import { getSenderById } from '../repos/senders.js';
import { ZodError } from 'zod';

const ApiSendBody = SendInputShape.omit({ tenantId: true, apiKeyId: true })
  .extend({ from: z.string().email().optional() })
  .refine((v) => (v.subject && v.html) || v.template, { message: 'Provide either subject+html or template' });
```

```ts
  app.post('/v1/emails', async (req, reply) => {
    try {
      const ctx = requireCtx(req);
      if (ctx.role !== 'api_key') throw new AppError('unauthorized', 401, 'API key required');

      let body;
      try { body = ApiSendBody.parse(req.body); }
      catch (e) {
        if (e instanceof ZodError) throw new AppError('validation_error', 422, e.issues[0]?.message ?? 'Invalid request body');
        throw e;
      }

      // Sender binding: a bound key forces `from` to its sender; a missing from on a tenant-wide key is invalid.
      let from = body.from;
      if (ctx.boundSenderId) {
        const bound = await getSenderById(app.pool, ctx.tenantId, ctx.boundSenderId);
        if (!bound) throw new AppError('invalid_sender', 422, 'Key is bound to a missing sender');
        if (!from) from = bound.email;
        else if (from !== bound.email) throw new AppError('invalid_sender', 422, `Key is restricted to ${bound.email}`);
      }
      // Guard required for type-narrowing too: after this line `from` is `string`, which
      // queueEmail's input demands. Covers the tenant-wide "from omitted" case.
      if (!from) throw new AppError('validation_error', 422, 'from is required');

      // ... (idempotency + queue/dispatch added in Task 6; for now, queue with resolved `from`)
      const email = await queueEmail({
        pool: app.pool,
        enqueueSend: async () => {},
        input: { ...body, from, tenantId: ctx.tenantId, apiKeyId: ctx.apiKeyId },
      });

      const isImmediate = !body.scheduled_for && email.status === 'queued';
      if (isImmediate) {
        const ours = await claimForSend(app.pool, email.id);
        if (ours) {
          const result = await dispatchEmail({ pool: app.pool, encKey: app.cfg.encKey, email: ours });
          if (result.ok) return reply.code(202).send({ id: email.id, status: 'sent', message_id: result.messageId, error: null });
          return reply.code(202).send({ id: email.id, status: 'failed', message_id: null, error: result.error });
        }
      }
      reply.code(202).send({ id: email.id, status: email.status, scheduled_for: email.scheduled_for });
    } catch (e) { sendError(reply, e); }
  });
```

- [ ] **Step 5: Run to verify pass**

Run: `npm -w server test -- v1Emails`
Expected: PASS (all binding + error-code tests). Re-run full suite: `npm -w server test` — green.

- [ ] **Step 6: Commit**

```bash
git add server/src/send/pipeline.ts server/src/routes/v1Emails.ts server/test/v1Emails.test.ts
git commit -m "feat(v1): enforce per-key sender binding and map errors to 422"
```

---

## Task 6: Idempotency (explicit key + content-hash fallback)

**Files:**
- Create: `server/src/send/dedupe.ts`
- Modify: `server/src/send/pipeline.ts`
- Modify: `server/src/routes/v1Emails.ts`
- Modify: `server/src/config.ts`
- Test: `server/test/v1Emails.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `server/test/v1Emails.test.ts`. These assert on **row count / identity**, so they hold
regardless of `queued` vs `sent` timing:

```ts
import { listEmails } from '../src/repos/emails.js';

it('same Idempotency-Key returns the same email and sends once', async () => {
  const { t, s, key } = await setup();
  const payload = { from: s.email, to: 'r@x.com', subject: 'Hi', html: '<p>x</p>' };
  const headers = { api_key: key, 'idempotency-key': 'run-123' };
  const r1 = await app.inject({ method: 'POST', url: '/v1/emails', headers, payload });
  const r2 = await app.inject({ method: 'POST', url: '/v1/emails', headers, payload });
  const id1 = (r1.json() as { id: string }).id;
  const id2 = (r2.json() as { id: string }).id;
  expect(id2).toBe(id1);
  expect(r2.statusCode).toBe(200);            // replay
  const rows = await listEmails(pool, t.id, { limit: 500 });
  expect(rows.length).toBe(1);
});

it('identical keyless body within window dedupes', async () => {
  const { t, s, key } = await setup();
  const payload = { from: s.email, to: 'r@x.com', subject: 'Dup', html: '<p>x</p>' };
  const headers = { api_key: key };
  await app.inject({ method: 'POST', url: '/v1/emails', headers, payload });
  const r2 = await app.inject({ method: 'POST', url: '/v1/emails', headers, payload });
  expect(r2.statusCode).toBe(200);
  const rows = await listEmails(pool, t.id, { limit: 500 });
  expect(rows.length).toBe(1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm -w server test -- v1Emails`
Expected: FAIL — two rows created; second call returns 202 not 200.

- [ ] **Step 3: Add config window** (`server/src/config.ts`)

Add to the Zod schema, the `Config` type, and the returned object:

```ts
  // in Schema:
  IDEMPOTENCY_WINDOW_MIN: z.coerce.number().int().min(0).max(1440).default(10),
```
```ts
  // in Config type:
  idempotencyWindowMin: number;
```
```ts
  // in the returned object:
  idempotencyWindowMin: p.IDEMPOTENCY_WINDOW_MIN,
```

- [ ] **Step 4: Create the hash helper** (`server/src/send/dedupe.ts`)

```ts
import { createHash } from 'node:crypto';

export function dedupeHash(tenantId: string, b: {
  from?: string; to: string; cc?: string[]; bcc?: string[];
  subject?: string; html?: string; text?: string;
  template?: string; variables?: Record<string, string>;
}): string {
  const canon = JSON.stringify([
    tenantId, b.from ?? '', b.to, b.cc ?? [], b.bcc ?? [],
    b.subject ?? '', b.html ?? '', b.text ?? '', b.template ?? '', b.variables ?? {},
  ]);
  return createHash('sha256').update(canon).digest('hex');
}
```

- [ ] **Step 5: Forward idempotency fields through `queueEmail`** (`server/src/send/pipeline.ts`)

Add optional fields to the `queueEmail` args and pass them into **both** `insertEmail` calls:

```ts
export async function queueEmail(args: {
  pool: pg.Pool;
  enqueueSend: (emailId: string) => Promise<void>;
  input: SendInputT;
  idempotencyKey?: string | null;
  dedupeHash?: string | null;
}): Promise<EmailRow> {
```
In each `insertEmail({...})` call inside `queueEmail`, add:
```ts
      idempotencyKey: args.idempotencyKey ?? null, dedupeHash: args.dedupeHash ?? null,
```

- [ ] **Step 6: Wire idempotency into the route** (`server/src/routes/v1Emails.ts`)

Add imports and replace the queue/dispatch section built in Task 5 with the idempotent version:

```ts
import { dedupeHash } from '../send/dedupe.js';
import { findEmailByIdempotencyKey, findRecentByDedupeHash } from '../repos/emails.js';

function storedResult(row: { id: string; status: string; message_id: string | null; error: string | null }) {
  return { id: row.id, status: row.status, message_id: row.message_id, error: row.error };
}
```

Between the binding block and `queueEmail`, insert:

```ts
      const idemKey = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'].trim() : '';
      const hash = idemKey ? null : dedupeHash(ctx.tenantId, { ...body, from });

      if (idemKey) {
        const existing = await findEmailByIdempotencyKey(app.pool, ctx.tenantId, idemKey);
        if (existing) return reply.code(200).send(storedResult(existing));
      } else if (hash) {
        const recent = await findRecentByDedupeHash(app.pool, ctx.tenantId, hash, app.cfg.idempotencyWindowMin);
        if (recent) return reply.code(200).send(storedResult(recent));
      }

      let email;
      try {
        email = await queueEmail({
          pool: app.pool, enqueueSend: async () => {},
          input: { ...body, from, tenantId: ctx.tenantId, apiKeyId: ctx.apiKeyId },
          idempotencyKey: idemKey || null, dedupeHash: hash,
        });
      } catch (e) {
        // Concurrent retry won the unique index race — return the stored row.
        if ((e as { code?: string }).code === '23505' && idemKey) {
          const existing = await findEmailByIdempotencyKey(app.pool, ctx.tenantId, idemKey);
          if (existing) return reply.code(200).send(storedResult(existing));
        }
        throw e;
      }
```

Leave the existing `isImmediate` claim/dispatch block (from Task 5) below this unchanged.

- [ ] **Step 7: Run to verify pass**

Run: `npm -w server test -- v1Emails`
Expected: PASS (both idempotency tests). Then full suite `npm -w server test` — green.

- [ ] **Step 8: Commit**

```bash
git add server/src/send/dedupe.ts server/src/send/pipeline.ts server/src/routes/v1Emails.ts server/src/config.ts server/test/v1Emails.test.ts
git commit -m "feat(v1): dual-mode idempotency (Idempotency-Key + content-hash fallback)"
```

---

## Task 7: API Keys UI — "Restrict to sender" dropdown

**Files:**
- Modify: `web/src/pages/ApiKeys.tsx`

- [ ] **Step 1: Implement the dropdown**

Update the `Key` interface and the `Generate` form to fetch senders and post an optional `senderId`:

```tsx
interface Key { id: string; name: string; key_prefix: string; sender_id: string | null; created_at: string; last_used_at: string | null; revoked_at: string | null }
interface SenderOpt { id: string; email: string }
```

```tsx
function Generate({ onDone }: { onDone: (plaintext: string) => void }) {
  const [name, setName] = useState('');
  const [senderId, setSenderId] = useState('');
  const [senders, setSenders] = useState<SenderOpt[]>([]);
  useEffect(() => { api<{ senders: SenderOpt[] }>('/api/senders').then(r => setSenders(r.senders)); }, []);
  return (
    <form className="space-y-3" onSubmit={async e => {
      e.preventDefault();
      const r = await api<{ plaintext: string }>('/api/api-keys', {
        method: 'POST',
        body: JSON.stringify({ name, ...(senderId ? { senderId } : {}) }),
      });
      onDone(r.plaintext);
    }}>
      <Field label="Name"><Input required value={name} onChange={e => setName(e.target.value)} /></Field>
      <Field label="Restrict to sender" hint="Leave as 'Any sender' for a tenant-wide key">
        <select className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm"
                value={senderId} onChange={e => setSenderId(e.target.value)}>
          <option value="">Any sender</option>
          {senders.map(s => <option key={s.id} value={s.id}>{s.email}</option>)}
        </select>
      </Field>
      <div className="flex justify-end"><Button type="submit">Generate</Button></div>
    </form>
  );
}
```

> Confirm the senders list endpoint shape: `GET /api/senders` returns `{ senders: [...] }`
> (it does — see `server/src/routes/senders.ts` / `listSenders`). Optionally add a "Sender"
> column to the table by rendering `k.sender_id` mapped to an email.

- [ ] **Step 2: Typecheck**

Run: `cd web && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/ApiKeys.tsx
git commit -m "feat(web): restrict-to-sender option when generating an API key"
```

---

## Task 8: Verify, security pass, and update docs

**Files:**
- Modify: `payload-fields.md` (flip 🔜 items now shipped)
- Modify: `README.md` (API quick reference: header options + Idempotency-Key)

- [ ] **Step 1: Full backend suite**

Run: `npm -w server test`
Expected: all suites green, including the new auth/idempotency/binding tests.

- [ ] **Step 2: Build both packages**

```bash
npm -w server run build && npm -w web run build
```
Expected: both compile; web build emits into `server/public`.

- [ ] **Step 3: Security self-check (auth was touched)**

Confirm by inspection:
- The raw key / `key` variable is never passed to a logger in `ctx.ts`.
- Idempotency lookups are tenant-scoped (`tenant_id = $1` in both new repo fns) — no cross-tenant replay.
- A sender-bound key cannot send as another sender (Task 5 tests cover foreign `from`).
- Invoke the project `security-review` skill over the diff (auth + input handling changed).

- [ ] **Step 4: Update the field reference + README**

In `payload-fields.md`, change the `api_key` and `Idempotency-Key` rows and the `200` replay note
from 🔜 to available. In `README.md`'s "API quick reference", document the three accepted auth
headers and the `Idempotency-Key` header.

- [ ] **Step 5: Commit**

```bash
git add payload-fields.md README.md
git commit -m "docs: mark api_key/idempotency headers as shipped"
```

---

## Out of scope here (go-live ops — track via spec §7)

These are operational, not TDD code tasks; execute against live infra after the code lands:
1. **Gmail e2e validation** — tenant + `liam@aiployee.co.za` Gmail sender (App Password) → real send; cron firing; scheduled send; bounce webhook; second-tenant isolation; idempotency replay live.
2. **Custom domain** — `emailer.aiployee.co.za` (confirm): add in Vercel, DNS CNAME, update `PUBLIC_BASE_URL`, repoint cron-job.org URLs, re-issue Jobix webhook URL.
3. **Ops/alerting** — `/healthz` uptime monitor (catches `DEPLOYMENT_DISABLED`), failed-email threshold alert (channel TBD, default `liam.p@regalis.co.za`), log audit for secrets.
4. **Deferred:** per-key rate limiting.

## Self-review note

Tests assert on row identity/counts rather than `queued`/`sent` to stay robust to inline-send
timing. If the existing `v1Emails.test.ts` "queues and sends end-to-end" test conflicts with current
inline-send behavior, fix that assertion as part of Task 4 (it shares the file) rather than leaving
a red baseline.
