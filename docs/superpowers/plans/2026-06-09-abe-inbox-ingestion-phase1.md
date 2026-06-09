# Abe Inbox Ingestion (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync a tenant's real IMAP INBOX into the database and correlate each received message to the sent campaign email / contact it replies to.

**Architecture:** Three new tables (`imap_configs`, `imap_sync_state`, `inbound_emails`) following the existing node-pg-migrate + `pg.Pool` repo pattern. A `packages/core/src/receive/imapFetch.ts` module pulls new messages over IMAP (via an injectable connection seam so it's testable without a live server), parses them with `mailparser`, correlates them, and inserts idempotently. A `CRON_SECRET`-guarded `/v1/cron/imap-fetch` Fastify route drives it on a schedule, mirroring the existing `/v1/cron/process-queue` route.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `pg` Pool, node-pg-migrate (`.cjs` migrations), Fastify v5, `imapflow` (IMAP client), `mailparser` (RFC822 parsing), AES-256-GCM via existing `packages/core/src/crypto/enc.ts`, Vitest (serial, `singleFork`) against the Neon test branch.

**Scope note:** This plan is Phase 1 only (ingestion + correlation) from `docs/superpowers/specs/2026-06-09-abe-inbox-intelligence-design.md`. Analysis columns on `inbound_emails` (`embedding`, `reply_group_id`, `group_fit`, `is_hot_lead`) are deliberately deferred to the Phase 2 migration so this migration is self-consistent. Phases 2 (campaign analysis) and 3 (proposal/drafting) get their own plans after Phase 1 is verified against the real mailbox.

---

## File Structure

- **Create** `server/migrations/1700000000036_imap_inbound.cjs` — the three tables + indexes.
- **Create** `packages/core/src/repos/imapConfigs.ts` — CRUD + decrypted-read for `imap_configs`, mirroring `repos/smtpConfigs.ts`.
- **Create** `packages/core/src/repos/imapSyncState.ts` — get/upsert the per-mailbox UID cursor.
- **Create** `packages/core/src/repos/inboundEmails.ts` — idempotent insert + lookups for `inbound_emails`.
- **Create** `packages/core/src/receive/parse.ts` — `parseRawEmail(Buffer)` wrapping `mailparser`.
- **Create** `packages/core/src/receive/correlate.ts` — `correlateReply(...)` pure DB correlation logic.
- **Create** `packages/core/src/receive/imapFetch.ts` — `syncMailbox(...)` orchestrator + `imapflowConnect` IO adapter + the `ImapSession`/`ImapConnect` seam.
- **Modify** `server/src/routes/cron.ts` — add `/v1/cron/imap-fetch`.
- **Modify** `vercel.json` — add the cron schedule entry.
- **Modify** `packages/core/package.json` — add `imapflow`, `mailparser` deps.
- **Create** tests under `server/test/`: `imapConfigs.test.ts`, `imapSyncState.test.ts`, `inboundEmails.test.ts`, `receive.correlate.test.ts`, `receive.parse.test.ts`, `receive.imapFetch.test.ts`.

Note on naming: the RFC822 `References` header is stored in a column named **`msg_references`** because node-pg-migrate treats a column key of `references` as a foreign-key directive.

---

## Task 0: Add dependencies

**Files:**
- Modify: `packages/core/package.json`

- [ ] **Step 1: Install runtime + type deps into packages/core**

Run:
```bash
npm -w packages/core i imapflow mailparser
npm -w packages/core i -D @types/mailparser
```
Expected: `packages/core/package.json` gains `imapflow` and `mailparser` under `dependencies`, `@types/mailparser` under `devDependencies`; lockfile updates. (`imapflow` ships its own types.)

- [ ] **Step 2: Verify install**

Run: `npm -w packages/core ls imapflow mailparser`
Expected: both resolve to installed versions, no `UNMET DEPENDENCY`.

- [ ] **Step 3: Commit**

```bash
git add packages/core/package.json package-lock.json
git commit -m "chore(core): add imapflow + mailparser for inbound mail"
```

---

## Task 1: Migration — imap_configs, imap_sync_state, inbound_emails

**Files:**
- Create: `server/migrations/1700000000036_imap_inbound.cjs`

- [ ] **Step 1: Write the migration**

Create `server/migrations/1700000000036_imap_inbound.cjs`:
```javascript
/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.createTable('imap_configs', {
    id:                 { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:          { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    sender_id:          { type: 'uuid', references: 'senders(id)', onDelete: 'SET NULL' },
    host:               { type: 'text', notNull: true },
    port:               { type: 'int',  notNull: true, default: 993 },
    secure:             { type: 'boolean', notNull: true, default: true },
    username:           { type: 'text', notNull: true },
    password_encrypted: { type: 'bytea', notNull: true },
    enabled:            { type: 'boolean', notNull: true, default: true },
    last_error:         { type: 'text' },
    created_at:         { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at:         { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('imap_configs', ['tenant_id']);

  pgm.createTable('imap_sync_state', {
    imap_config_id: { type: 'uuid', notNull: true, references: 'imap_configs(id)', onDelete: 'CASCADE' },
    folder:         { type: 'text', notNull: true, default: 'INBOX' },
    uid_validity:   { type: 'bigint', notNull: true, default: 0 },
    last_seen_uid:  { type: 'bigint', notNull: true, default: 0 },
    last_synced_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('imap_sync_state', 'imap_sync_state_pk', { primaryKey: ['imap_config_id', 'folder'] });

  pgm.createTable('inbound_emails', {
    id:             { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:      { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    imap_config_id: { type: 'uuid', notNull: true, references: 'imap_configs(id)', onDelete: 'CASCADE' },
    imap_uid:       { type: 'bigint', notNull: true },
    message_id:     { type: 'text', notNull: true },
    in_reply_to:    { type: 'text' },
    msg_references: { type: 'text' },
    from_addr:      { type: 'text', notNull: true },
    from_name:      { type: 'text' },
    to_addr:        { type: 'text' },
    subject:        { type: 'text' },
    body_text:      { type: 'text' },
    body_html:      { type: 'text' },
    received_at:    { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    email_id:       { type: 'uuid', references: 'emails(id)', onDelete: 'SET NULL' },
    campaign_id:    { type: 'uuid', references: 'campaigns(id)', onDelete: 'SET NULL' },
    contact_id:     { type: 'uuid', references: 'contacts(id)', onDelete: 'SET NULL' },
    status:         { type: 'text', notNull: true, default: 'new' },
    created_at:     { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('inbound_emails', 'inbound_emails_tenant_msgid_uniq', { unique: ['tenant_id', 'message_id'] });
  pgm.addConstraint('inbound_emails', 'inbound_emails_config_uid_uniq', { unique: ['imap_config_id', 'imap_uid'] });
  pgm.createIndex('inbound_emails', ['tenant_id', 'received_at'], { name: 'inbound_emails_tenant_received_idx' });
  pgm.createIndex('inbound_emails', ['campaign_id']);
  pgm.createIndex('inbound_emails', ['email_id']);
};

exports.down = (pgm) => {
  pgm.dropTable('inbound_emails');
  pgm.dropTable('imap_sync_state');
  pgm.dropTable('imap_configs');
};
```

- [ ] **Step 2: Run the migration against the test DB**

Run: `TEST_DATABASE_URL=<neon test branch url> npm -w server run migrate`
(Use the test/dev connection string from your env per the infra-topology note — do NOT run against prod here.)
Expected: output lists `1700000000036_imap_inbound` as migrated, exit 0.

- [ ] **Step 3: Verify tables exist**

Run: `psql <test db url> -c "\d inbound_emails"`
Expected: shows the columns above including `msg_references` and the two unique constraints.

- [ ] **Step 4: Commit**

```bash
git add server/migrations/1700000000036_imap_inbound.cjs
git commit -m "feat(db): migration for imap_configs, imap_sync_state, inbound_emails"
```

---

## Task 2: imapConfigs repo

**Files:**
- Create: `packages/core/src/repos/imapConfigs.ts`
- Test: `server/test/imapConfigs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/imapConfigs.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import {
  createImapConfig,
  listEnabledImapConfigs,
  listAllEnabledImapConfigs,
  getImapConfigWithPassword,
} from '@aiployee/core/repos/imapConfigs.js';

const pool = makePool();
const encKey = Buffer.alloc(32, 7);
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('imapConfigs repo', () => {
  it('creates a config and reads it back with a decrypted password', async () => {
    const t = await createTenant(pool);
    const created = await createImapConfig(pool, encKey, {
      tenantId: t.id, senderId: null, host: 'imap.example.com', port: 993,
      secure: true, username: 'box@example.com', password: 's3cret', enabled: true,
    });
    expect(created.host).toBe('imap.example.com');
    const withPw = await getImapConfigWithPassword(pool, encKey, created.id);
    expect(withPw?.password).toBe('s3cret');
    expect((withPw as Record<string, unknown>).password_encrypted).toBeUndefined();
  });

  it('lists only enabled configs for a tenant and across all tenants', async () => {
    const t = await createTenant(pool);
    await createImapConfig(pool, encKey, { tenantId: t.id, senderId: null, host: 'a', port: 993, secure: true, username: 'a', password: 'p', enabled: true });
    await createImapConfig(pool, encKey, { tenantId: t.id, senderId: null, host: 'b', port: 993, secure: true, username: 'b', password: 'p', enabled: false });
    expect((await listEnabledImapConfigs(pool, t.id)).length).toBe(1);
    expect((await listAllEnabledImapConfigs(pool)).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w server test -- imapConfigs`
Expected: FAIL — cannot resolve `@aiployee/core/repos/imapConfigs.js` / module not found.

- [ ] **Step 3: Write the repo**

Create `packages/core/src/repos/imapConfigs.ts`:
```typescript
import type pg from 'pg';
import { encrypt, decrypt } from '../crypto/enc.js';

export interface ImapConfigRow {
  id: string;
  tenant_id: string;
  sender_id: string | null;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  enabled: boolean;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLS =
  'id, tenant_id, sender_id, host, port, secure, username, enabled, last_error, created_at, updated_at';

export async function createImapConfig(
  pool: pg.Pool,
  key: Buffer,
  input: {
    tenantId: string; senderId: string | null; host: string; port: number;
    secure: boolean; username: string; password: string; enabled: boolean;
  },
): Promise<ImapConfigRow> {
  const enc = encrypt(input.password, key);
  const r = await pool.query<ImapConfigRow>(
    `INSERT INTO imap_configs(tenant_id, sender_id, host, port, secure, username, password_encrypted, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING ${SELECT_COLS}`,
    [input.tenantId, input.senderId, input.host, input.port, input.secure, input.username, enc, input.enabled],
  );
  return r.rows[0];
}

export async function listEnabledImapConfigs(pool: pg.Pool, tenantId: string): Promise<ImapConfigRow[]> {
  const r = await pool.query<ImapConfigRow>(
    `SELECT ${SELECT_COLS} FROM imap_configs WHERE tenant_id = $1 AND enabled = true ORDER BY created_at DESC`,
    [tenantId],
  );
  return r.rows;
}

export async function listAllEnabledImapConfigs(pool: pg.Pool): Promise<ImapConfigRow[]> {
  const r = await pool.query<ImapConfigRow>(
    `SELECT ${SELECT_COLS} FROM imap_configs WHERE enabled = true ORDER BY tenant_id, created_at`,
  );
  return r.rows;
}

export async function getImapConfigWithPassword(
  pool: pg.Pool,
  key: Buffer,
  id: string,
): Promise<(ImapConfigRow & { password: string }) | null> {
  const r = await pool.query<ImapConfigRow & { password_encrypted: Buffer }>(
    `SELECT ${SELECT_COLS}, password_encrypted FROM imap_configs WHERE id = $1`,
    [id],
  );
  const row = r.rows[0];
  if (!row) return null;
  const { password_encrypted, ...rest } = row;
  return { ...(rest as ImapConfigRow), password: decrypt(password_encrypted, key) };
}

export async function setImapConfigError(pool: pg.Pool, id: string, error: string | null): Promise<void> {
  await pool.query(
    `UPDATE imap_configs SET last_error = $2, updated_at = now() WHERE id = $1`,
    [id, error],
  );
}
```

- [ ] **Step 4: Confirm the package export path resolves**

The test imports `@aiployee/core/repos/imapConfigs.js`. Confirm `packages/core` already exposes `./repos/*` (the existing tests import `../src/repos/...` directly, and `chatTools.ts` imports repos by relative path). If `@aiployee/core/repos/imapConfigs.js` does NOT resolve, change the test import to the relative form used elsewhere:
```typescript
import { createImapConfig, listEnabledImapConfigs, listAllEnabledImapConfigs, getImapConfigWithPassword } from '../../packages/core/src/repos/imapConfigs.js';
```
(Check how `server/test/abe.chatTools.test.ts` imports repos and match that style exactly.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npm -w server test -- imapConfigs`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/repos/imapConfigs.ts server/test/imapConfigs.test.ts
git commit -m "feat(core): imap_configs repo with encrypted password round-trip"
```

---

## Task 3: imapSyncState repo

**Files:**
- Create: `packages/core/src/repos/imapSyncState.ts`
- Test: `server/test/imapSyncState.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/imapSyncState.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createImapConfig } from '@aiployee/core/repos/imapConfigs.js';
import { getSyncState, upsertSyncState } from '@aiployee/core/repos/imapSyncState.js';

const pool = makePool();
const encKey = Buffer.alloc(32, 7);
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function aConfig() {
  const t = await createTenant(pool);
  return createImapConfig(pool, encKey, { tenantId: t.id, senderId: null, host: 'h', port: 993, secure: true, username: 'u', password: 'p', enabled: true });
}

describe('imapSyncState repo', () => {
  it('returns null when no cursor exists yet', async () => {
    const cfg = await aConfig();
    expect(await getSyncState(pool, cfg.id, 'INBOX')).toBeNull();
  });

  it('upserts and reads back the cursor', async () => {
    const cfg = await aConfig();
    await upsertSyncState(pool, cfg.id, 'INBOX', { uidValidity: 42, lastSeenUid: 100 });
    let s = await getSyncState(pool, cfg.id, 'INBOX');
    expect(s).toEqual(expect.objectContaining({ uid_validity: '42', last_seen_uid: '100' }));
    await upsertSyncState(pool, cfg.id, 'INBOX', { uidValidity: 42, lastSeenUid: 250 });
    s = await getSyncState(pool, cfg.id, 'INBOX');
    expect(s?.last_seen_uid).toBe('250');
  });
});
```
(Note: `pg` returns `bigint` columns as strings, hence `'42'`/`'250'`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w server test -- imapSyncState`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the repo**

Create `packages/core/src/repos/imapSyncState.ts`:
```typescript
import type pg from 'pg';

export interface SyncStateRow {
  imap_config_id: string;
  folder: string;
  uid_validity: string;   // bigint as string
  last_seen_uid: string;  // bigint as string
  last_synced_at: string | null;
}

export async function getSyncState(
  pool: pg.Pool, imapConfigId: string, folder: string,
): Promise<SyncStateRow | null> {
  const r = await pool.query<SyncStateRow>(
    `SELECT imap_config_id, folder, uid_validity, last_seen_uid, last_synced_at
     FROM imap_sync_state WHERE imap_config_id = $1 AND folder = $2`,
    [imapConfigId, folder],
  );
  return r.rows[0] ?? null;
}

export async function upsertSyncState(
  pool: pg.Pool, imapConfigId: string, folder: string,
  state: { uidValidity: number; lastSeenUid: number },
): Promise<void> {
  await pool.query(
    `INSERT INTO imap_sync_state(imap_config_id, folder, uid_validity, last_seen_uid, last_synced_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (imap_config_id, folder)
     DO UPDATE SET uid_validity = EXCLUDED.uid_validity,
                   last_seen_uid = EXCLUDED.last_seen_uid,
                   last_synced_at = now()`,
    [imapConfigId, folder, state.uidValidity, state.lastSeenUid],
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w server test -- imapSyncState`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/repos/imapSyncState.ts server/test/imapSyncState.test.ts
git commit -m "feat(core): imap_sync_state cursor repo"
```

---

## Task 4: inboundEmails repo

**Files:**
- Create: `packages/core/src/repos/inboundEmails.ts`
- Test: `server/test/inboundEmails.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/inboundEmails.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createImapConfig } from '@aiployee/core/repos/imapConfigs.js';
import { insertInboundEmail, listInboundByCampaign } from '@aiployee/core/repos/inboundEmails.js';

const pool = makePool();
const encKey = Buffer.alloc(32, 7);
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('inboundEmails repo', () => {
  it('inserts and is idempotent on (tenant_id, message_id)', async () => {
    const t = await createTenant(pool);
    const cfg = await createImapConfig(pool, encKey, { tenantId: t.id, senderId: null, host: 'h', port: 993, secure: true, username: 'u', password: 'p', enabled: true });
    const base = {
      tenantId: t.id, imapConfigId: cfg.id, imapUid: 1, messageId: '<m1@x>',
      inReplyTo: null, references: null, fromAddr: 'a@x.com', fromName: 'A',
      toAddr: 'box@x.com', subject: 'Re: hi', bodyText: 'hello', bodyHtml: null,
      receivedAt: new Date('2026-06-09T10:00:00Z'),
      emailId: null, campaignId: null, contactId: null,
    };
    const first = await insertInboundEmail(pool, base);
    expect(first.inserted).toBe(true);
    const dup = await insertInboundEmail(pool, { ...base, imapUid: 2 });
    expect(dup.inserted).toBe(false); // same message_id → no-op
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w server test -- inboundEmails`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the repo**

Create `packages/core/src/repos/inboundEmails.ts`:
```typescript
import type pg from 'pg';

export interface InboundEmailInput {
  tenantId: string;
  imapConfigId: string;
  imapUid: number;
  messageId: string;
  inReplyTo: string | null;
  references: string | null;
  fromAddr: string;
  fromName: string | null;
  toAddr: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  receivedAt: Date;
  emailId: string | null;
  campaignId: string | null;
  contactId: string | null;
}

export interface InboundEmailRow {
  id: string;
  tenant_id: string;
  campaign_id: string | null;
  email_id: string | null;
  contact_id: string | null;
  from_addr: string;
  subject: string | null;
  body_text: string | null;
  received_at: string;
  status: string;
}

export async function insertInboundEmail(
  pool: pg.Pool, input: InboundEmailInput,
): Promise<{ inserted: boolean; id: string | null }> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO inbound_emails(
        tenant_id, imap_config_id, imap_uid, message_id, in_reply_to, msg_references,
        from_addr, from_name, to_addr, subject, body_text, body_html, received_at,
        email_id, campaign_id, contact_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (tenant_id, message_id) DO NOTHING
     RETURNING id`,
    [
      input.tenantId, input.imapConfigId, input.imapUid, input.messageId, input.inReplyTo, input.references,
      input.fromAddr, input.fromName, input.toAddr, input.subject, input.bodyText, input.bodyHtml, input.receivedAt,
      input.emailId, input.campaignId, input.contactId,
    ],
  );
  const row = r.rows[0];
  return { inserted: !!row, id: row?.id ?? null };
}

export async function listInboundByCampaign(
  pool: pg.Pool, tenantId: string, campaignId: string,
): Promise<InboundEmailRow[]> {
  const r = await pool.query<InboundEmailRow>(
    `SELECT id, tenant_id, campaign_id, email_id, contact_id, from_addr, subject, body_text, received_at, status
     FROM inbound_emails
     WHERE tenant_id = $1 AND campaign_id = $2
     ORDER BY received_at DESC`,
    [tenantId, campaignId],
  );
  return r.rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w server test -- inboundEmails`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/repos/inboundEmails.ts server/test/inboundEmails.test.ts
git commit -m "feat(core): inbound_emails repo with idempotent insert"
```

---

## Task 5: Correlation logic

**Files:**
- Create: `packages/core/src/receive/correlate.ts`
- Test: `server/test/receive.correlate.test.ts`

Correlation rules (from spec):
1. Exact: any `In-Reply-To`/`References` message-id matches `emails.message_id` → take that email's `id`, `campaign_id`, and resolve `contact_id` from `to_addr`/`contacts`.
2. Fallback: `from_addr` matches a tenant `contacts.email` AND subject starts with `re:` → set `contact_id`, and `campaign_id` = that contact's most recent sent email's campaign within 30 days.
3. None: all null.

- [ ] **Step 1: Write the failing test**

Create `server/test/receive.correlate.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { correlateReply } from '@aiployee/core/receive/correlate.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

// Minimal raw inserts so the test does not depend on factories that may not exist.
async function seedCampaignSend(tenantId: string, opts: { messageId: string; toAddr: string }) {
  const c = await pool.query<{ id: string }>(
    `INSERT INTO campaigns(tenant_id, name, status) VALUES ($1,'C','draft') RETURNING id`, [tenantId]);
  const campaignId = c.rows[0].id;
  const contact = await pool.query<{ id: string }>(
    `INSERT INTO contacts(tenant_id, email, name) VALUES ($1,$2,'X') RETURNING id`, [tenantId, opts.toAddr]);
  const e = await pool.query<{ id: string }>(
    `INSERT INTO emails(tenant_id, to_addr, subject, status, message_id, campaign_id, sent_at)
     VALUES ($1,$2,'Hello','sent',$3,$4, now()) RETURNING id`,
    [tenantId, opts.toAddr, opts.messageId, campaignId]);
  return { campaignId, contactId: contact.rows[0].id, emailId: e.rows[0].id };
}

describe('correlateReply', () => {
  it('matches exactly via In-Reply-To → emails.message_id', async () => {
    const t = await createTenant(pool);
    const seed = await seedCampaignSend(t.id, { messageId: '<sent-1@x>', toAddr: 'lead@x.com' });
    const res = await correlateReply(pool, t.id, {
      fromAddr: 'lead@x.com', subject: 'Re: Hello', inReplyTo: '<sent-1@x>', references: null,
    });
    expect(res).toEqual({ emailId: seed.emailId, campaignId: seed.campaignId, contactId: seed.contactId });
  });

  it('falls back to contact + Re: subject within 30 days', async () => {
    const t = await createTenant(pool);
    const seed = await seedCampaignSend(t.id, { messageId: '<sent-2@x>', toAddr: 'lead@x.com' });
    const res = await correlateReply(pool, t.id, {
      fromAddr: 'lead@x.com', subject: 'RE: something else', inReplyTo: null, references: null,
    });
    expect(res.contactId).toBe(seed.contactId);
    expect(res.campaignId).toBe(seed.campaignId);
    expect(res.emailId).toBeNull();
  });

  it('returns all-null when nothing matches', async () => {
    const t = await createTenant(pool);
    const res = await correlateReply(pool, t.id, {
      fromAddr: 'stranger@x.com', subject: 'cold inbound', inReplyTo: null, references: null,
    });
    expect(res).toEqual({ emailId: null, campaignId: null, contactId: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w server test -- receive.correlate`
Expected: FAIL — module not found.

> If a column referenced in `seedCampaignSend` (`emails.to_addr`, `emails.message_id`, `emails.campaign_id`, `emails.sent_at`, `campaigns.name/status`, `contacts.email/name`) does not match the real schema, fix the INSERT to match the columns confirmed in the migrations (`1700000000004_emails...`, `1700000000019_campaigns.cjs`, `1700000000017_contacts_lists.cjs`). Do not change `correlate.ts` to accommodate a wrong test fixture.

- [ ] **Step 3: Write the correlation module**

Create `packages/core/src/receive/correlate.ts`:
```typescript
import type pg from 'pg';

export interface CorrelationInput {
  fromAddr: string;
  subject: string | null;
  inReplyTo: string | null;
  references: string | null;
}

export interface Correlation {
  emailId: string | null;
  campaignId: string | null;
  contactId: string | null;
}

function refMessageIds(input: CorrelationInput): string[] {
  const ids: string[] = [];
  if (input.inReplyTo) ids.push(input.inReplyTo.trim());
  if (input.references) for (const r of input.references.split(/\s+/)) if (r) ids.push(r.trim());
  return [...new Set(ids)];
}

function isReplySubject(subject: string | null): boolean {
  return !!subject && /^\s*re\s*:/i.test(subject);
}

async function contactIdForEmail(pool: pg.Pool, tenantId: string, addr: string): Promise<string | null> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM contacts WHERE tenant_id = $1 AND lower(email) = lower($2) LIMIT 1`,
    [tenantId, addr],
  );
  return r.rows[0]?.id ?? null;
}

export async function correlateReply(
  pool: pg.Pool, tenantId: string, input: CorrelationInput,
): Promise<Correlation> {
  // 1. Exact: a referenced message-id matches a sent email.
  const ids = refMessageIds(input);
  if (ids.length) {
    const r = await pool.query<{ id: string; campaign_id: string | null; to_addr: string }>(
      `SELECT id, campaign_id, to_addr FROM emails
       WHERE tenant_id = $1 AND message_id = ANY($2::text[])
       ORDER BY sent_at DESC NULLS LAST LIMIT 1`,
      [tenantId, ids],
    );
    const hit = r.rows[0];
    if (hit) {
      const contactId = await contactIdForEmail(pool, tenantId, hit.to_addr);
      return { emailId: hit.id, campaignId: hit.campaign_id, contactId };
    }
  }

  // 2. Fallback: known contact + Re: subject → most recent campaign send in 30 days.
  if (isReplySubject(input.subject)) {
    const contactId = await contactIdForEmail(pool, tenantId, input.fromAddr);
    if (contactId) {
      const r = await pool.query<{ campaign_id: string | null }>(
        `SELECT campaign_id FROM emails
         WHERE tenant_id = $1 AND lower(to_addr) = lower($2)
           AND campaign_id IS NOT NULL
           AND sent_at >= now() - interval '30 days'
         ORDER BY sent_at DESC LIMIT 1`,
        [tenantId, input.fromAddr],
      );
      return { emailId: null, campaignId: r.rows[0]?.campaign_id ?? null, contactId };
    }
  }

  // 3. None.
  return { emailId: null, campaignId: null, contactId: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w server test -- receive.correlate`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/receive/correlate.ts server/test/receive.correlate.test.ts
git commit -m "feat(core): correlate inbound replies to sent campaign emails"
```

---

## Task 6: RFC822 parser

**Files:**
- Create: `packages/core/src/receive/parse.ts`
- Test: `server/test/receive.parse.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/receive.parse.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { parseRawEmail } from '@aiployee/core/receive/parse.js';

const RAW = Buffer.from(
  [
    'From: Jane Lead <jane@lead.com>',
    'To: box@us.com',
    'Subject: Re: Hello',
    'Message-ID: <reply-1@lead.com>',
    'In-Reply-To: <sent-1@us.com>',
    'References: <sent-1@us.com>',
    'Date: Tue, 09 Jun 2026 10:00:00 +0000',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'What are your opening hours?',
    '',
  ].join('\r\n'),
  'utf8',
);

describe('parseRawEmail', () => {
  it('extracts headers, address, and body', async () => {
    const p = await parseRawEmail(RAW);
    expect(p.messageId).toBe('<reply-1@lead.com>');
    expect(p.inReplyTo).toBe('<sent-1@us.com>');
    expect(p.references).toContain('<sent-1@us.com>');
    expect(p.fromAddr).toBe('jane@lead.com');
    expect(p.fromName).toBe('Jane Lead');
    expect(p.subject).toBe('Re: Hello');
    expect(p.bodyText?.trim()).toBe('What are your opening hours?');
    expect(p.receivedAt instanceof Date).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w server test -- receive.parse`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the parser**

Create `packages/core/src/receive/parse.ts`:
```typescript
import { simpleParser } from 'mailparser';

export interface ParsedInbound {
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  fromAddr: string;
  fromName: string | null;
  toAddr: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  receivedAt: Date;
}

export async function parseRawEmail(source: Buffer): Promise<ParsedInbound> {
  const m = await simpleParser(source);
  const fromValue = m.from?.value?.[0];
  const references = Array.isArray(m.references)
    ? m.references.join(' ')
    : (m.references ?? null);
  const toText = (() => {
    const to = m.to;
    if (!to) return null;
    return Array.isArray(to) ? to.map(t => t.text).join(', ') : to.text;
  })();
  return {
    messageId: m.messageId ?? null,
    inReplyTo: m.inReplyTo ?? null,
    references: references && references.length ? references : null,
    fromAddr: fromValue?.address ?? '',
    fromName: fromValue?.name || null,
    toAddr: toText ?? null,
    subject: m.subject ?? null,
    bodyText: m.text ?? null,
    bodyHtml: typeof m.html === 'string' ? m.html : null,
    receivedAt: m.date ?? new Date(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w server test -- receive.parse`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/receive/parse.ts server/test/receive.parse.test.ts
git commit -m "feat(core): parse raw RFC822 inbound email via mailparser"
```

---

## Task 7: Sync orchestrator + IMAP adapter

**Files:**
- Create: `packages/core/src/receive/imapFetch.ts`
- Test: `server/test/receive.imapFetch.test.ts`

The orchestrator depends on an injectable `ImapConnect` seam so it is testable with a fake mailbox. The real `imapflowConnect` adapter wraps `imapflow` and is exercised only manually / in integration, not in the unit test.

- [ ] **Step 1: Write the failing test (fake IMAP session)**

Create `server/test/receive.imapFetch.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createImapConfig } from '@aiployee/core/repos/imapConfigs.js';
import { getSyncState } from '@aiployee/core/repos/imapSyncState.js';
import { listInboundByCampaign } from '@aiployee/core/repos/inboundEmails.js';
import { syncMailbox } from '@aiployee/core/receive/imapFetch.js';
import type { ImapSession, RawMessage } from '@aiployee/core/receive/imapFetch.js';

const pool = makePool();
const encKey = Buffer.alloc(32, 7);
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

function rawReply(uid: number, messageId: string, inReplyTo: string): RawMessage {
  const src = Buffer.from([
    'From: Jane Lead <lead@x.com>', 'To: box@x.com', 'Subject: Re: Hello',
    `Message-ID: <${messageId}>`, `In-Reply-To: <${inReplyTo}>`,
    'Date: Tue, 09 Jun 2026 10:00:00 +0000', 'Content-Type: text/plain', '',
    'opening hours?', '',
  ].join('\r\n'), 'utf8');
  return { uid, source: src };
}

describe('syncMailbox', () => {
  it('fetches new messages, correlates, inserts, and advances the cursor', async () => {
    const t = await createTenant(pool);
    const cfg = await createImapConfig(pool, encKey, { tenantId: t.id, senderId: null, host: 'h', port: 993, secure: true, username: 'u', password: 'p', enabled: true });

    // Seed a sent campaign email so correlation finds a campaign.
    const c = await pool.query<{ id: string }>(`INSERT INTO campaigns(tenant_id, name, status) VALUES ($1,'C','draft') RETURNING id`, [t.id]);
    await pool.query(`INSERT INTO contacts(tenant_id, email, name) VALUES ($1,'lead@x.com','L')`, [t.id]);
    await pool.query(
      `INSERT INTO emails(tenant_id, to_addr, subject, status, message_id, campaign_id, sent_at) VALUES ($1,'lead@x.com','Hello','sent','<sent-1@x>',$2, now())`,
      [t.id, c.rows[0].id]);

    const fakeConnect = async (): Promise<ImapSession> => ({
      uidValidity: 555,
      async *fetchSince(uid: number): AsyncIterable<RawMessage> {
        const all = [rawReply(10, 'reply-1@x', 'sent-1@x')];
        for (const m of all) if (m.uid > uid) yield m;
      },
      async close() { /* noop */ },
    });

    const res = await syncMailbox({ pool, encKey, configId: cfg.id, connect: fakeConnect });
    expect(res.fetched).toBe(1);
    expect(res.inserted).toBe(1);

    const rows = await listInboundByCampaign(pool, t.id, c.rows[0].id);
    expect(rows.length).toBe(1);
    expect(rows[0].from_addr).toBe('lead@x.com');

    const state = await getSyncState(pool, cfg.id, 'INBOX');
    expect(state?.last_seen_uid).toBe('10');
    expect(state?.uid_validity).toBe('555');
  });

  it('is idempotent on a second run with the same mailbox', async () => {
    const t = await createTenant(pool);
    const cfg = await createImapConfig(pool, encKey, { tenantId: t.id, senderId: null, host: 'h', port: 993, secure: true, username: 'u', password: 'p', enabled: true });
    const connect = async (): Promise<ImapSession> => ({
      uidValidity: 1,
      async *fetchSince(uid: number) { if (10 > uid) yield rawReply(10, 'only@x', 'none@x'); },
      async close() {},
    });
    const first = await syncMailbox({ pool, encKey, configId: cfg.id, connect });
    const second = await syncMailbox({ pool, encKey, configId: cfg.id, connect });
    expect(first.inserted).toBe(1);
    expect(second.fetched).toBe(0); // cursor advanced past uid 10
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w server test -- receive.imapFetch`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the orchestrator + adapter**

Create `packages/core/src/receive/imapFetch.ts`:
```typescript
import type pg from 'pg';
import { getImapConfigWithPassword, setImapConfigError } from '../repos/imapConfigs.js';
import { getSyncState, upsertSyncState } from '../repos/imapSyncState.js';
import { insertInboundEmail } from '../repos/inboundEmails.js';
import { parseRawEmail } from './parse.js';
import { correlateReply } from './correlate.js';

const FOLDER = 'INBOX';
const MAX_PER_RUN = 200;

export interface RawMessage { uid: number; source: Buffer }

export interface ImapSession {
  uidValidity: number;
  fetchSince(uid: number): AsyncIterable<RawMessage>;
  close(): Promise<void>;
}

export interface ImapCreds {
  host: string; port: number; secure: boolean; user: string; pass: string;
}

export type ImapConnect = (creds: ImapCreds) => Promise<ImapSession>;

export interface SyncResult { fetched: number; inserted: number }

export async function syncMailbox(args: {
  pool: pg.Pool;
  encKey: Buffer;
  configId: string;
  connect?: ImapConnect;
}): Promise<SyncResult> {
  const { pool, encKey, configId } = args;
  const connect = args.connect ?? imapflowConnect;

  const cfg = await getImapConfigWithPassword(pool, encKey, configId);
  if (!cfg) throw new Error(`imap_config ${configId} not found`);

  let session: ImapSession | null = null;
  try {
    session = await connect({ host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.username, pass: cfg.password });

    const state = await getSyncState(pool, configId, FOLDER);
    const storedValidity = state ? Number(state.uid_validity) : 0;
    // If UIDVALIDITY changed (or first run), reset the cursor to 0.
    const lastSeen = state && storedValidity === session.uidValidity ? Number(state.last_seen_uid) : 0;

    let fetched = 0;
    let inserted = 0;
    let maxUid = lastSeen;

    for await (const msg of session.fetchSince(lastSeen)) {
      if (fetched >= MAX_PER_RUN) break;
      fetched += 1;
      if (msg.uid > maxUid) maxUid = msg.uid;

      const parsed = await parseRawEmail(msg.source);
      if (!parsed.messageId) continue; // cannot dedup without a Message-ID
      const corr = await correlateReply(pool, cfg.tenant_id, {
        fromAddr: parsed.fromAddr, subject: parsed.subject, inReplyTo: parsed.inReplyTo, references: parsed.references,
      });
      const r = await insertInboundEmail(pool, {
        tenantId: cfg.tenant_id, imapConfigId: configId, imapUid: msg.uid,
        messageId: parsed.messageId, inReplyTo: parsed.inReplyTo, references: parsed.references,
        fromAddr: parsed.fromAddr, fromName: parsed.fromName, toAddr: parsed.toAddr,
        subject: parsed.subject, bodyText: parsed.bodyText, bodyHtml: parsed.bodyHtml, receivedAt: parsed.receivedAt,
        emailId: corr.emailId, campaignId: corr.campaignId, contactId: corr.contactId,
      });
      if (r.inserted) inserted += 1;
    }

    await upsertSyncState(pool, configId, FOLDER, { uidValidity: session.uidValidity, lastSeenUid: maxUid });
    await setImapConfigError(pool, configId, null);
    return { fetched, inserted };
  } catch (e) {
    await setImapConfigError(pool, configId, (e as Error).message);
    throw e;
  } finally {
    if (session) { try { await session.close(); } catch { /* ignore */ } }
  }
}

// Real IMAP adapter (exercised manually / in integration, not in unit tests).
export const imapflowConnect: ImapConnect = async (creds) => {
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({
    host: creds.host, port: creds.port, secure: creds.secure,
    auth: { user: creds.user, pass: creds.pass }, logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock(FOLDER);
  const uidValidity = Number((client.mailbox && typeof client.mailbox === 'object' ? client.mailbox.uidValidity : 0) ?? 0);
  return {
    uidValidity,
    async *fetchSince(uid: number): AsyncIterable<RawMessage> {
      // UID range: messages with uid greater than the cursor.
      for await (const m of client.fetch({ uid: `${uid + 1}:*` }, { uid: true, source: true })) {
        if (m.uid > uid && m.source) yield { uid: m.uid, source: m.source as Buffer };
      }
    },
    async close() {
      try { lock.release(); } finally { await client.logout(); }
    },
  };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w server test -- receive.imapFetch`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/receive/imapFetch.ts server/test/receive.imapFetch.test.ts
git commit -m "feat(core): syncMailbox orchestrator + imapflow adapter"
```

---

## Task 8: Cron route + Vercel schedule

**Files:**
- Modify: `server/src/routes/cron.ts`
- Modify: `vercel.json`

- [ ] **Step 1: Add the route handler**

In `server/src/routes/cron.ts`, add a new `cron(...)` registration alongside the existing ones (inside `registerCronRoutes`, after `/v1/cron/process-queue`). Add the import at the top of the file:
```typescript
import { listAllEnabledImapConfigs } from '@aiployee/core/repos/imapConfigs.js';
import { syncMailbox } from '@aiployee/core/receive/imapFetch.js';
```
Then the route:
```typescript
  cron('/v1/cron/imap-fetch', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      requireCronAuth(req, app.cfg.cronSecret);
      const configs = await listAllEnabledImapConfigs(app.pool);
      let fetched = 0;
      let inserted = 0;
      let failed = 0;
      for (const c of configs) {
        try {
          const r = await syncMailbox({ pool: app.pool, encKey: app.cfg.encKey, configId: c.id });
          fetched += r.fetched;
          inserted += r.inserted;
        } catch (e) {
          failed += 1;
          app.log.error({ imapConfigId: c.id, err: (e as Error).message }, 'imap-fetch failed for config');
        }
      }
      return reply.send({ ok: true, mailboxes: configs.length, fetched, inserted, failed });
    } catch (e) { sendError(reply, e); }
  });
```
(Match the exact import style for repos already used in `cron.ts` — if it imports `@aiployee/core/...` use that; if it uses relative paths, mirror them.)

- [ ] **Step 2: Add the Vercel cron schedule**

In `vercel.json`, add to the `crons` array (every 5 minutes):
```json
{ "path": "/v1/cron/imap-fetch", "schedule": "*/5 * * * *" }
```

- [ ] **Step 3: Typecheck + build the server**

Run: `npm -w server run build`
Expected: TypeScript compiles with no errors; new route compiles into `server/dist`.

- [ ] **Step 4: Run the full server test suite once (serial)**

Run: `npm -w server test`
Expected: all suites PASS, including the six new files. (Runs serially via `singleFork` per `vitest.config.ts`; do not run a second suite concurrently on the shared Neon branch.)

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/cron.ts vercel.json
git commit -m "feat(cron): /v1/cron/imap-fetch syncs all enabled mailboxes"
```

---

## Task 9: Manual verification against a real mailbox

**Files:** none (verification only)

- [ ] **Step 1: Create an imap_config for the campaign mailbox**

Using a one-off script or psql + the repo, insert an enabled `imap_configs` row for the real campaign sending account (IMAP host derived from the SMTP host — e.g. `smtp.gmail.com` → `imap.gmail.com`, port 993, secure true). Use the same account credentials the campaign sends from (an app-password if the provider requires it).

- [ ] **Step 2: Trigger the cron locally**

Run (against the dev/test deployment, with the real cron secret):
```bash
curl -s -X POST "$BASE_URL/v1/cron/imap-fetch" -H "Authorization: Bearer $CRON_SECRET"
```
Expected JSON: `{ "ok": true, "mailboxes": 1, "fetched": <n>, "inserted": <n>, "failed": 0 }`.

- [ ] **Step 3: Confirm correlation against the launched campaign**

Run:
```bash
psql <db url> -c "SELECT from_addr, subject, campaign_id IS NOT NULL AS correlated, status FROM inbound_emails ORDER BY received_at DESC LIMIT 20;"
```
Expected: replies to the first campaign show `correlated = t`; the cursor in `imap_sync_state` advanced; a second curl run inserts 0 duplicates.

- [ ] **Step 4: Report results**

Confirm: messages synced, replies correlated to the right campaign, idempotent on re-run, `imap_configs.last_error` is null. Phase 1 done.

---

## Self-Review

**Spec coverage (Phase 1 sections):**
- IMAP creds storage (encrypted, option A) → Tasks 1, 2. ✓
- `imap_sync_state` (only fetch new) → Tasks 1, 3, 7. ✓
- `inbound_emails` schema → Tasks 1, 4. ✓ (analysis columns deferred to Phase 2 — noted in scope.)
- Fetch module in `packages/core/src/receive/` (imapflow + mailparser) → Tasks 6, 7. ✓
- Correlation (exact In-Reply-To → fallback contact+Re: → none) → Task 5. ✓
- Cron route guarded by `CRON_SECRET` + Vercel schedule → Task 8. ✓
- Privacy (no body logging) → orchestrator logs only ids/messages, never bodies. ✓
- Error handling (per-mailbox failure isolated, UIDVALIDITY reset) → Task 7 (`storedValidity !== uidValidity` resets cursor), Task 8 (per-config try/catch). ✓
- Idempotency (unique constraints) → Tasks 1, 4, 7 (second-run test). ✓
- Verified against real mailbox → Task 9. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. ✓

**Type consistency:** `ImapConfigRow`, `InboundEmailInput`, `ParsedInbound`, `Correlation`, `ImapSession`/`RawMessage`/`ImapConnect`, `SyncResult` are defined once and used consistently. `correlateReply(pool, tenantId, {fromAddr, subject, inReplyTo, references})` signature matches all call sites (Task 5 test + Task 7 orchestrator). `insertInboundEmail` input shape matches the orchestrator's call. `references` (input field) maps to DB column `msg_references` only inside the repo SQL — consistent. ✓

**Deferred to later plans (not Phase 1):** embeddings/clustering, `campaign_analyses`/`reply_groups`, Abe chat tools, feed rollups, drafting into the approval flow, `security-review` + dependency audit (run before the whole feature merges).
