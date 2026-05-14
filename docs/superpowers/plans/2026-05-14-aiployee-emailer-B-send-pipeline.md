# AIployee Emailer Implementation Plan — Part B: Send Pipeline, Scheduling, Bounces

> **Built for AIployee.** Internal multi-tenant transactional email service for AIployee's automation workflows and AIployee's clients.
>
> **Cost target: ~$5/month all-in.** This plan adds zero new infrastructure: pg-boss runs inside the existing Postgres (no Redis), the worker runs inside the existing Node process (no extra container), webhooks ride on the existing Fastify port. Total operational cost stays at the Hetzner CX11 line item.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prereq:** Plan A complete and acceptance checks pass.

**Goal:** Add the actual email-sending machinery: `POST /v1/emails`, immediate dispatch via Nodemailer, scheduled-send poller, retries via pg-boss, bounce/complaint webhooks for SES + Mailgun, and per-tenant suppression list.

**Architecture additions:**
- pg-boss embedded in the same Node process as Fastify.
- One queue: `send-email` (job payload: `{ emailId }`).
- Scheduler: pg-boss recurring job every 30s that enqueues queued emails whose `scheduled_for <= now()`.
- Webhook routes are public (`/v1/webhooks/bounce/:provider`), signature-verified per provider, mounted before the ctx middleware skips them.

---

## Files

```
server/src/
  send/
    pipeline.ts         validateAndQueueEmail(ctx, input) → { id, status }
    worker.ts           handleSendJob(emailId)
    scheduler.ts        startScheduler(boss): poll queued+due → enqueue
    sender.ts           (from Plan A) buildTransport
  repos/
    emails.ts           insertEmail, getEmail, listEmails, claimForSend, markSent, markFailed, markStatus
    suppressions.ts     isSuppressed, addSuppression, listSuppressions, removeSuppression
    bounceEvents.ts     insertBounceEvent
  routes/
    v1Emails.ts         POST /v1/emails, GET /v1/emails/:id, GET /v1/emails
    v1Webhooks.ts       POST /v1/webhooks/bounce/:provider
    emails.ts           GET /api/emails, GET /api/emails/:id (UI read)
    suppressions.ts     /api/suppressions CRUD
  webhooks/
    ses.ts              SNS signature verify + parse
    mailgun.ts          HMAC verify + parse
  boss.ts               pg-boss singleton + start/stop helpers
server/test/
  pipeline.test.ts
  worker.test.ts
  scheduler.test.ts
  v1Emails.test.ts
  bounce.ses.test.ts
  bounce.mailgun.test.ts
  helpers/
    smtp.ts             smtp-tester wrapper
```

---

# Phase 11 — Send pipeline (immediate)

### Task 11.1: pg-boss singleton

**Files:** Create `server/src/boss.ts`

- [ ] **Step 1: Implement**

```ts
import PgBoss from 'pg-boss';
import type { Config } from './config.js';

let boss: PgBoss | null = null;

export async function startBoss(cfg: Config): Promise<PgBoss> {
  if (boss) return boss;
  boss = new PgBoss({ connectionString: cfg.databaseUrl, schema: 'pgboss' });
  await boss.start();
  return boss;
}

export async function stopBoss(): Promise<void> {
  if (boss) { await boss.stop({ graceful: true }); boss = null; }
}

export function getBoss(): PgBoss {
  if (!boss) throw new Error('pg-boss not started');
  return boss;
}
```

- [ ] **Step 2: Wire `startBoss` into `app.ts` after `getPool`. Add `app.addHook('onClose', stopBoss);`. Commit.**

```bash
git add . && git commit -m "feat(boss): pg-boss start/stop wiring"
```

### Task 11.2: Emails repo

**Files:** Create `server/src/repos/emails.ts`, `server/test/emails.repo.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createSmtpConfig } from '../src/repos/smtpConfigs.js';
import { createSender } from '../src/repos/senders.js';
import { insertEmail, claimForSend, markSent, markFailed, getEmail } from '../src/repos/emails.js';

const KEY = Buffer.alloc(32, 1);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function setup() {
  const t = await createTenant(pool);
  const sc = await createSmtpConfig(pool, KEY, {
    tenantId: t.id, name: 'SES', host: 'h', port: 25, secure: false,
    username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
  });
  const s = await createSender(pool, {
    tenantId: t.id, email: 'a@x.com', displayName: 'A', smtpConfigId: sc.id,
  });
  return { t, sc, s };
}

describe('emails repo', () => {
  it('inserts queued email and transitions to sent', async () => {
    const { t, s } = await setup();
    const e = await insertEmail(pool, {
      tenantId: t.id, senderId: s.id, toAddr: 'r@x.com',
      subject: 'Hi', bodyHtml: '<p>x</p>',
    });
    expect(e.status).toBe('queued');
    const claimed = await claimForSend(pool, e.id);
    expect(claimed!.status).toBe('sending');
    await markSent(pool, e.id, 'msg-1');
    const after = await getEmail(pool, t.id, e.id);
    expect(after!.status).toBe('sent');
    expect(after!.message_id).toBe('msg-1');
  });

  it('markFailed records error', async () => {
    const { t, s } = await setup();
    const e = await insertEmail(pool, {
      tenantId: t.id, senderId: s.id, toAddr: 'r@x.com',
      subject: 'Hi', bodyHtml: '<p>x</p>',
    });
    await markFailed(pool, e.id, 'connection refused');
    const after = await getEmail(pool, t.id, e.id);
    expect(after!.status).toBe('failed');
    expect(after!.error).toBe('connection refused');
  });
});
```

- [ ] **Step 2: Implement `server/src/repos/emails.ts`**

```ts
import type pg from 'pg';

export type EmailStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'bounced' | 'complained' | 'suppressed';

export interface EmailRow {
  id: string; tenant_id: string; sender_id: string;
  to_addr: string; cc: string[]; bcc: string[]; reply_to: string | null;
  subject: string; body_html: string; body_text: string | null;
  template_id: string | null; attachments: unknown[];
  status: EmailStatus; scheduled_for: Date | null; sent_at: Date | null;
  error: string | null; message_id: string | null; api_key_id: string | null;
  created_at: Date;
}

const SELECT = `
  id, tenant_id, sender_id, to_addr, cc, bcc, reply_to,
  subject, body_html, body_text, template_id, attachments, status,
  scheduled_for, sent_at, error, message_id, api_key_id, created_at`;

export async function insertEmail(pool: pg.Pool, input: {
  tenantId: string; senderId: string; toAddr: string; cc?: string[]; bcc?: string[];
  replyTo?: string | null; subject: string; bodyHtml: string; bodyText?: string | null;
  templateId?: string | null; attachments?: unknown[]; scheduledFor?: Date | null;
  apiKeyId?: string | null; status?: EmailStatus;
}): Promise<EmailRow> {
  const r = await pool.query<EmailRow>(
    `INSERT INTO emails(tenant_id, sender_id, to_addr, cc, bcc, reply_to,
                         subject, body_html, body_text, template_id, attachments,
                         status, scheduled_for, api_key_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)
     RETURNING ${SELECT}`,
    [
      input.tenantId, input.senderId, input.toAddr,
      input.cc ?? [], input.bcc ?? [], input.replyTo ?? null,
      input.subject, input.bodyHtml, input.bodyText ?? null,
      input.templateId ?? null, JSON.stringify(input.attachments ?? []),
      input.status ?? 'queued', input.scheduledFor ?? null, input.apiKeyId ?? null,
    ],
  );
  return r.rows[0];
}

export async function getEmail(pool: pg.Pool, tenantId: string, id: string): Promise<EmailRow | null> {
  const r = await pool.query<EmailRow>(
    `SELECT ${SELECT} FROM emails WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return r.rows[0] ?? null;
}

export async function listEmails(pool: pg.Pool, tenantId: string, opts: {
  status?: EmailStatus; since?: Date; limit?: number;
} = {}): Promise<EmailRow[]> {
  const where = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  if (opts.status) { params.push(opts.status); where.push(`status = $${params.length}`); }
  if (opts.since) { params.push(opts.since); where.push(`created_at >= $${params.length}`); }
  params.push(Math.min(opts.limit ?? 100, 500));
  const r = await pool.query<EmailRow>(
    `SELECT ${SELECT} FROM emails WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC LIMIT $${params.length}`, params);
  return r.rows;
}

export async function claimForSend(pool: pg.Pool, id: string): Promise<EmailRow | null> {
  const r = await pool.query<EmailRow>(
    `UPDATE emails SET status = 'sending'
     WHERE id = $1 AND status IN ('queued','failed') RETURNING ${SELECT}`, [id]);
  return r.rows[0] ?? null;
}

export async function markSent(pool: pg.Pool, id: string, messageId: string): Promise<void> {
  await pool.query(
    `UPDATE emails SET status='sent', sent_at = now(), message_id = $2, error = NULL WHERE id = $1`,
    [id, messageId]);
}

export async function markFailed(pool: pg.Pool, id: string, error: string): Promise<void> {
  await pool.query(`UPDATE emails SET status='failed', error = $2 WHERE id = $1`, [id, error]);
}

export async function markStatus(pool: pg.Pool, id: string, status: EmailStatus): Promise<void> {
  await pool.query(`UPDATE emails SET status = $2 WHERE id = $1`, [id, status]);
}

export async function findByMessageId(pool: pg.Pool, messageId: string): Promise<EmailRow | null> {
  const r = await pool.query<EmailRow>(
    `SELECT ${SELECT} FROM emails WHERE message_id = $1 LIMIT 1`, [messageId]);
  return r.rows[0] ?? null;
}
```

- [ ] **Step 3: Run, PASS, commit.**

```bash
npm -w server test
git add . && git commit -m "feat(repos): emails with status lifecycle"
```

### Task 11.3: Suppressions repo

**Files:** Create `server/src/repos/suppressions.ts`, `server/test/suppressions.repo.test.ts`

- [ ] **Step 1: Implement**

```ts
import type pg from 'pg';

export interface SuppressionRow { id: string; tenant_id: string; address: string; reason: string; created_at: Date }

export async function isSuppressed(pool: pg.Pool, tenantId: string, address: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM suppressions WHERE tenant_id = $1 AND lower(address) = lower($2)`,
    [tenantId, address]);
  return (r.rowCount ?? 0) > 0;
}

export async function addSuppression(pool: pg.Pool, input: {
  tenantId: string; address: string; reason: 'bounce' | 'complaint' | 'manual';
}): Promise<void> {
  await pool.query(
    `INSERT INTO suppressions(tenant_id, address, reason)
     VALUES ($1, lower($2), $3)
     ON CONFLICT (tenant_id, address) DO NOTHING`,
    [input.tenantId, input.address, input.reason]);
}

export async function listSuppressions(pool: pg.Pool, tenantId: string): Promise<SuppressionRow[]> {
  const r = await pool.query<SuppressionRow>(
    `SELECT id, tenant_id, address, reason, created_at
     FROM suppressions WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return r.rows;
}

export async function removeSuppression(pool: pg.Pool, tenantId: string, address: string): Promise<boolean> {
  const r = await pool.query(
    `DELETE FROM suppressions WHERE tenant_id = $1 AND lower(address) = lower($2)`,
    [tenantId, address]);
  return r.rowCount === 1;
}
```

- [ ] **Step 2: Test (insert + isSuppressed roundtrip + tenant isolation), commit.**

```bash
git add . && git commit -m "feat(repos): suppressions with case-insensitive match"
```

### Task 11.4: Pipeline (validate, render, insert, enqueue)

**Files:** Create `server/src/send/pipeline.ts`, `server/test/pipeline.test.ts`

- [ ] **Step 1: Failing test `server/test/pipeline.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createSmtpConfig } from '../src/repos/smtpConfigs.js';
import { createSender } from '../src/repos/senders.js';
import { createTemplate } from '../src/repos/templates.js';
import { addSuppression } from '../src/repos/suppressions.js';
import { queueEmail } from '../src/send/pipeline.js';

const KEY = Buffer.alloc(32, 1);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function setup() {
  const t = await createTenant(pool);
  const sc = await createSmtpConfig(pool, KEY, {
    tenantId: t.id, name: 'SES', host: 'h', port: 25, secure: false,
    username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
  });
  const s = await createSender(pool, { tenantId: t.id, email: 'a@x.com', displayName: 'A', smtpConfigId: sc.id });
  return { t, s };
}

describe('queueEmail', () => {
  it('inserts queued email for raw subject+html send', async () => {
    const { t, s } = await setup();
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const r = await queueEmail({
      pool, enqueueSend: enqueue,
      input: { tenantId: t.id, fromEmail: s.email, to: 'r@x.com', subject: 'Hi', html: '<p>hi</p>' },
    });
    expect(r.status).toBe('queued');
    expect(enqueue).toHaveBeenCalledWith(r.id);
  });

  it('renders template + variables', async () => {
    const { t, s } = await setup();
    const tpl = await createTemplate(pool, {
      tenantId: t.id, name: 'welcome',
      subject: 'Hi {{name}}', bodyHtml: '<p>Hello {{name}}</p>',
    });
    const r = await queueEmail({
      pool, enqueueSend: async () => {},
      input: { tenantId: t.id, fromEmail: s.email, to: 'r@x.com', template: 'welcome', variables: { name: 'Alex' } },
    });
    expect(r.status).toBe('queued');
    // Re-fetch and verify subject was rendered
    const row = await pool.query<{ subject: string; body_html: string }>(
      `SELECT subject, body_html FROM emails WHERE id = $1`, [r.id]);
    expect(row.rows[0].subject).toBe('Hi Alex');
    expect(row.rows[0].body_html).toBe('<p>Hello Alex</p>');
  });

  it('rejects unknown sender', async () => {
    const { t } = await setup();
    await expect(queueEmail({
      pool, enqueueSend: async () => {},
      input: { tenantId: t.id, fromEmail: 'nope@x.com', to: 'r@x.com', subject: 'Hi', html: '<p>x</p>' },
    })).rejects.toMatchObject({ code: 'invalid_sender' });
  });

  it('rejects suppressed recipient (logged with status=suppressed)', async () => {
    const { t, s } = await setup();
    await addSuppression(pool, { tenantId: t.id, address: 'bad@x.com', reason: 'bounce' });
    const r = await queueEmail({
      pool, enqueueSend: async () => {},
      input: { tenantId: t.id, fromEmail: s.email, to: 'bad@x.com', subject: 'Hi', html: '<p>x</p>' },
    });
    expect(r.status).toBe('suppressed');
  });

  it('records scheduled_for without enqueueing immediately', async () => {
    const { t, s } = await setup();
    const enqueue = vi.fn();
    const future = new Date(Date.now() + 60_000);
    const r = await queueEmail({
      pool, enqueueSend: enqueue,
      input: { tenantId: t.id, fromEmail: s.email, to: 'r@x.com', subject: 'Hi', html: '<p>x</p>', scheduledFor: future },
    });
    expect(r.status).toBe('queued');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement `server/src/send/pipeline.ts`**

```ts
import type pg from 'pg';
import { z } from 'zod';
import { AppError } from '../util/errors.js';
import { getSenderByEmail } from '../repos/senders.js';
import { getTemplateByName } from '../repos/templates.js';
import { isSuppressed } from '../repos/suppressions.js';
import { insertEmail, type EmailRow } from '../repos/emails.js';
import { render } from './render.js';

export const SendInput = z.object({
  tenantId: z.string().uuid(),
  fromEmail: z.string().email(),
  to: z.string().email(),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  replyTo: z.string().email().optional(),
  subject: z.string().min(1).optional(),
  html: z.string().min(1).optional(),
  text: z.string().optional(),
  template: z.string().optional(),
  variables: z.record(z.string(), z.string()).optional(),
  attachments: z.array(z.object({
    filename: z.string(),
    content: z.string(),       // base64
    contentType: z.string().optional(),
  })).optional(),
  scheduledFor: z.coerce.date().optional(),
  apiKeyId: z.string().uuid().optional(),
}).refine(
  (v) => (v.subject && v.html) || v.template,
  { message: 'Provide either subject+html or template' },
);

export type SendInputT = z.infer<typeof SendInput>;

export async function queueEmail(args: {
  pool: pg.Pool;
  enqueueSend: (emailId: string) => Promise<void>;
  input: SendInputT;
}): Promise<EmailRow> {
  const input = SendInput.parse(args.input);
  const sender = await getSenderByEmail(args.pool, input.tenantId, input.fromEmail);
  if (!sender) throw new AppError('invalid_sender', 400, `Sender not found: ${input.fromEmail}`);

  let subject = input.subject ?? '';
  let bodyHtml = input.html ?? '';
  let bodyText = input.text ?? null;
  let templateId: string | null = null;

  if (input.template) {
    const tpl = await getTemplateByName(args.pool, input.tenantId, input.template);
    if (!tpl) throw new AppError('template_not_found', 404, `Template not found: ${input.template}`);
    templateId = tpl.id;
    const vars = input.variables ?? {};
    try {
      subject = render(tpl.subject, vars, { escape: false });
      bodyHtml = render(tpl.body_html, vars);
      bodyText = tpl.body_text ? render(tpl.body_text, vars, { escape: false }) : null;
    } catch (e) {
      throw new AppError('render_failed', 400, (e as Error).message);
    }
  }

  if (await isSuppressed(args.pool, input.tenantId, input.to)) {
    return insertEmail(args.pool, {
      tenantId: input.tenantId, senderId: sender.id, toAddr: input.to,
      cc: input.cc, bcc: input.bcc, replyTo: input.replyTo ?? null,
      subject, bodyHtml, bodyText, templateId, attachments: input.attachments,
      status: 'suppressed', apiKeyId: input.apiKeyId ?? null,
    });
  }

  const email = await insertEmail(args.pool, {
    tenantId: input.tenantId, senderId: sender.id, toAddr: input.to,
    cc: input.cc, bcc: input.bcc, replyTo: input.replyTo ?? null,
    subject, bodyHtml, bodyText, templateId, attachments: input.attachments,
    scheduledFor: input.scheduledFor ?? null,
    status: 'queued', apiKeyId: input.apiKeyId ?? null,
  });

  if (!input.scheduledFor || input.scheduledFor.getTime() <= Date.now()) {
    await args.enqueueSend(email.id);
  }

  return email;
}
```

- [ ] **Step 3: Run, PASS, commit.**

```bash
npm -w server test
git add . && git commit -m "feat(send): pipeline (validate, render, insert, conditional enqueue)"
```

### Task 11.5: Worker (handle send-email job)

**Files:** Create `server/src/send/worker.ts`, `server/test/helpers/smtp.ts`, `server/test/worker.test.ts`

- [ ] **Step 1: SMTP helper `server/test/helpers/smtp.ts`**

```ts
// Tiny in-process SMTP server using smtp-tester
import smtpTester from 'smtp-tester';

export function startTestSmtp(port = 2525): { port: number; close: () => Promise<void>; lastMail: () => Promise<unknown> } {
  const mailServer = smtpTester.init(port);
  let lastResolve: ((v: unknown) => void) | null = null;
  mailServer.bind((_addr: string, _id: number, email: unknown) => { lastResolve?.(email); lastResolve = null; });
  return {
    port,
    close: () => new Promise<void>(res => mailServer.stop(res)),
    lastMail: () => new Promise(resolve => { lastResolve = resolve; }),
  };
}
```

- [ ] **Step 2: Implement `server/src/send/worker.ts`**

```ts
import type pg from 'pg';
import { logger } from '../util/logger.js';
import { claimForSend, markSent, markFailed } from '../repos/emails.js';
import { getSenderById } from '../repos/senders.js';
import { getSmtpConfigWithPassword } from '../repos/smtpConfigs.js';
import { buildTransport } from './sender.js';

export async function handleSendJob(args: {
  pool: pg.Pool;
  encKey: Buffer;
  emailId: string;
}): Promise<void> {
  const email = await claimForSend(args.pool, args.emailId);
  if (!email) {
    logger.info({ emailId: args.emailId }, 'send job skipped: not in queued/failed state');
    return;
  }
  try {
    const sender = await getSenderById(args.pool, email.tenant_id, email.sender_id);
    if (!sender) throw new Error(`sender ${email.sender_id} not found`);
    const cfg = await getSmtpConfigWithPassword(args.pool, args.encKey, email.tenant_id, sender.smtp_config_id);
    if (!cfg) throw new Error(`smtp_config ${sender.smtp_config_id} not found`);
    const tx = buildTransport(cfg);
    try {
      const info = await tx.sendMail({
        from: { name: sender.display_name, address: sender.email },
        to: email.to_addr,
        cc: email.cc.length ? email.cc : undefined,
        bcc: email.bcc.length ? email.bcc : undefined,
        replyTo: email.reply_to ?? sender.reply_to ?? undefined,
        subject: email.subject,
        html: email.body_html,
        text: email.body_text ?? undefined,
        attachments: (email.attachments as Array<{ filename: string; content: string; contentType?: string }>).map(a => ({
          filename: a.filename, content: Buffer.from(a.content, 'base64'), contentType: a.contentType,
        })),
      });
      await markSent(args.pool, email.id, info.messageId);
    } finally { tx.close(); }
  } catch (e) {
    const msg = (e as Error).message;
    logger.warn({ emailId: email.id, err: msg }, 'send failed');
    await markFailed(args.pool, email.id, msg);
    throw e; // let pg-boss retry per its policy
  }
}
```

- [ ] **Step 3: Worker test `server/test/worker.test.ts`** — boots smtp-tester on a port, creates tenant/sender pointing at it, queues an email, runs `handleSendJob`, asserts message arrives and DB row is `sent`.

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { startTestSmtp } from './helpers/smtp.js';
import { createTenant } from './helpers/factories.js';
import { createSmtpConfig } from '../src/repos/smtpConfigs.js';
import { createSender } from '../src/repos/senders.js';
import { insertEmail, getEmail } from '../src/repos/emails.js';
import { handleSendJob } from '../src/send/worker.js';

const KEY = Buffer.alloc(32, 1);
const pool = makePool();
let smtp: ReturnType<typeof startTestSmtp>;

beforeAll(() => { smtp = startTestSmtp(2526); });
afterAll(async () => { await smtp.close(); await pool.end(); });
beforeEach(async () => { await truncateAll(pool); });

describe('handleSendJob', () => {
  it('delivers a queued email through SMTP and marks it sent', async () => {
    const t = await createTenant(pool);
    const sc = await createSmtpConfig(pool, KEY, {
      tenantId: t.id, name: 'local', host: '127.0.0.1', port: 2526, secure: false,
      username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
    });
    const s = await createSender(pool, { tenantId: t.id, email: 'a@x.com', displayName: 'A', smtpConfigId: sc.id });
    const e = await insertEmail(pool, {
      tenantId: t.id, senderId: s.id, toAddr: 'r@x.com',
      subject: 'Hi', bodyHtml: '<p>hi</p>',
    });
    const recv = smtp.lastMail();
    await handleSendJob({ pool, encKey: KEY, emailId: e.id });
    const mail = await recv as { headers: Record<string, string> };
    expect(mail.headers.subject).toContain('Hi');
    const after = await getEmail(pool, t.id, e.id);
    expect(after!.status).toBe('sent');
    expect(after!.message_id).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run, PASS, commit.**

```bash
npm -w server test
git add . && git commit -m "feat(send): worker dispatches via Nodemailer + records status"
```

### Task 11.6: Wire pg-boss queue to worker, expose POST /v1/emails

**Files:** Create `server/src/routes/v1Emails.ts`, modify `server/src/app.ts`

- [ ] **Step 1: Implement `server/src/routes/v1Emails.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sendError, AppError } from '../util/errors.js';
import { queueEmail, SendInput } from '../send/pipeline.js';
import { getEmail, listEmails, type EmailStatus } from '../repos/emails.js';
import { getBoss } from '../boss.js';
import { requireCtx } from '../auth/ctx.js';

const ApiSendBody = SendInput.omit({ tenantId: true, apiKeyId: true });

export async function registerV1EmailRoutes(app: FastifyInstance) {
  app.post('/v1/emails', async (req, reply) => {
    try {
      const ctx = requireCtx(req);
      if (ctx.role !== 'api_key') throw new AppError('unauthorized', 401, 'API key required');
      const body = ApiSendBody.parse(req.body);
      const email = await queueEmail({
        pool: app.pool,
        enqueueSend: async (id) => { await getBoss().send('send-email', { emailId: id }); },
        input: { ...body, tenantId: ctx.tenantId, apiKeyId: ctx.apiKeyId },
      });
      reply.code(202).send({ id: email.id, status: email.status, scheduledFor: email.scheduled_for });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/v1/emails/:id', async (req, reply) => {
    try {
      const ctx = requireCtx(req);
      const { id } = req.params as { id: string };
      const e = await getEmail(app.pool, ctx.tenantId, id);
      if (!e) throw new AppError('not_found', 404, 'Email not found');
      reply.send({ email: e });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/v1/emails', async (req, reply) => {
    try {
      const ctx = requireCtx(req);
      const q = z.object({
        status: z.string().optional(),
        since: z.coerce.date().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }).parse(req.query);
      const list = await listEmails(app.pool, ctx.tenantId, {
        status: q.status as EmailStatus | undefined, since: q.since, limit: q.limit,
      });
      reply.send({ emails: list });
    } catch (e) { sendError(reply, e); }
  });
}
```

- [ ] **Step 2: Wire pg-boss worker in `app.ts`**

After `await startBoss(cfg);` register a worker:

```ts
import { handleSendJob } from './send/worker.js';
// ...inside buildApp, after startBoss + before returning:
const boss = await startBoss(cfg);
await boss.work<{ emailId: string }>('send-email', { teamSize: 5, teamConcurrency: 5 }, async ([job]) => {
  await handleSendJob({ pool, encKey: cfg.encKey, emailId: job.data.emailId });
});
await registerV1EmailRoutes(app);
```

- [ ] **Step 3: End-to-end test `server/test/v1Emails.test.ts`** — generate API key for tenant, POST `/v1/emails`, wait briefly, assert SMTP received + status sent.
- [ ] **Step 4: Run, PASS, commit.**

```bash
git add . && git commit -m "feat(api): POST /v1/emails wired to pg-boss + worker"
```

---

# Phase 12 — Scheduled sends

### Task 12.1: Scheduler poller

**Files:** Create `server/src/send/scheduler.ts`, `server/test/scheduler.test.ts`

- [ ] **Step 1: Implement `server/src/send/scheduler.ts`**

```ts
import type pg from 'pg';
import type PgBoss from 'pg-boss';
import { logger } from '../util/logger.js';

export async function pollDueScheduled(args: { pool: pg.Pool; boss: PgBoss }): Promise<number> {
  const r = await args.pool.query<{ id: string }>(
    `SELECT id FROM emails
     WHERE status = 'queued' AND scheduled_for IS NOT NULL AND scheduled_for <= now()
     ORDER BY scheduled_for ASC LIMIT 200`);
  for (const row of r.rows) {
    await args.boss.send('send-email', { emailId: row.id });
  }
  if (r.rowCount && r.rowCount > 0) logger.info({ count: r.rowCount }, 'scheduler enqueued due emails');
  return r.rowCount ?? 0;
}

export function startScheduler(args: { pool: pg.Pool; boss: PgBoss; intervalMs?: number }): () => void {
  const interval = args.intervalMs ?? 30_000;
  const t = setInterval(() => {
    pollDueScheduled(args).catch(err => logger.error({ err }, 'scheduler tick failed'));
  }, interval);
  return () => clearInterval(t);
}
```

- [ ] **Step 2: Test `server/test/scheduler.test.ts`** — insert email with `scheduled_for = now() - 1min`, run `pollDueScheduled`, assert returns 1 and pg-boss `send` was called (use a mocked boss with `send: vi.fn()`).
- [ ] **Step 3: Wire in `app.ts`** — `const stop = startScheduler({ pool, boss });` and `app.addHook('onClose', async () => stop());`.
- [ ] **Step 4: Commit.**

```bash
npm -w server test
git add . && git commit -m "feat(send): scheduled-send poller (30s tick)"
```

---

# Phase 13 — Bounce webhooks + suppressions UI

### Task 13.1: SES SNS webhook

**Files:** Create `server/src/webhooks/ses.ts`, `server/src/routes/v1Webhooks.ts`, `server/test/bounce.ses.test.ts`

- [ ] **Step 1: Implement `server/src/webhooks/ses.ts`**

```ts
import https from 'node:https';
import { createVerify } from 'node:crypto';

interface SnsMessage {
  Type: string;
  MessageId: string;
  Token?: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  SubscribeURL?: string;
}

const certCache = new Map<string, string>();

async function fetchCert(url: string): Promise<string> {
  if (certCache.has(url)) return certCache.get(url)!;
  if (!/^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com\//.test(url)) throw new Error('invalid SigningCertURL');
  const cert = await new Promise<string>((resolve, reject) => {
    https.get(url, (res) => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', c => (data += c));
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
  certCache.set(url, cert);
  return cert;
}

function buildStringToSign(m: SnsMessage): string {
  const fields = m.Type === 'Notification'
    ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
    : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  let s = '';
  for (const k of fields) {
    const v = (m as Record<string, string | undefined>)[k];
    if (v !== undefined) s += `${k}\n${v}\n`;
  }
  return s;
}

export async function verifySnsMessage(msg: SnsMessage): Promise<void> {
  const cert = await fetchCert(msg.SigningCertURL);
  const verify = createVerify(msg.SignatureVersion === '2' ? 'sha256WithRSAEncryption' : 'sha1WithRSAEncryption');
  verify.update(buildStringToSign(msg), 'utf8');
  if (!verify.verify(cert, msg.Signature, 'base64')) throw new Error('SNS signature invalid');
}

export interface ParsedSesEvent {
  type: 'bounce' | 'complaint' | 'delivery';
  messageId: string;
  recipients: string[];
}

export function parseSesNotification(messageJson: string): ParsedSesEvent | null {
  const m = JSON.parse(messageJson) as {
    notificationType?: string; eventType?: string;
    mail?: { messageId: string };
    bounce?: { bounceType: string; bouncedRecipients: { emailAddress: string }[] };
    complaint?: { complainedRecipients: { emailAddress: string }[] };
  };
  const t = (m.notificationType ?? m.eventType ?? '').toLowerCase();
  if (!m.mail?.messageId) return null;
  if (t === 'bounce' && m.bounce?.bounceType === 'Permanent') {
    return { type: 'bounce', messageId: m.mail.messageId, recipients: m.bounce.bouncedRecipients.map(r => r.emailAddress) };
  }
  if (t === 'complaint' && m.complaint) {
    return { type: 'complaint', messageId: m.mail.messageId, recipients: m.complaint.complainedRecipients.map(r => r.emailAddress) };
  }
  if (t === 'delivery') {
    return { type: 'delivery', messageId: m.mail.messageId, recipients: [] };
  }
  return null;
}
```

- [ ] **Step 2: Implement `server/src/routes/v1Webhooks.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { sendError, AppError } from '../util/errors.js';
import { verifySnsMessage, parseSesNotification } from '../webhooks/ses.js';
import { verifyMailgun, parseMailgunEvent } from '../webhooks/mailgun.js';
import { findByMessageId, markStatus } from '../repos/emails.js';
import { addSuppression } from '../repos/suppressions.js';

export async function registerV1WebhookRoutes(app: FastifyInstance) {
  app.post('/v1/webhooks/bounce/ses', async (req, reply) => {
    try {
      const body = req.body as Record<string, string>;
      await verifySnsMessage(body as never);
      if (body.Type === 'SubscriptionConfirmation' && body.SubscribeURL) {
        // Auto-confirm by GETing SubscribeURL out-of-band; logged so operator sees it.
        req.log.info({ url: body.SubscribeURL }, 'SNS subscription confirmation received');
        return reply.send({ ok: true, confirm: body.SubscribeURL });
      }
      const ev = parseSesNotification(body.Message);
      if (!ev) return reply.send({ ok: true, ignored: true });
      const email = await findByMessageId(app.pool, ev.messageId);
      if (!email) return reply.send({ ok: true, unknown: true });
      if (ev.type === 'bounce' || ev.type === 'complaint') {
        await markStatus(app.pool, email.id, ev.type === 'bounce' ? 'bounced' : 'complained');
        for (const r of ev.recipients) {
          await addSuppression(app.pool, { tenantId: email.tenant_id, address: r, reason: ev.type });
        }
      }
      reply.send({ ok: true });
    } catch (e) { sendError(reply, new AppError('webhook_failed', 400, (e as Error).message)); }
  });

  app.post('/v1/webhooks/bounce/mailgun', async (req, reply) => {
    try {
      const body = req.body as Record<string, unknown>;
      verifyMailgun(body as never, app.cfg);
      const ev = parseMailgunEvent(body);
      if (!ev) return reply.send({ ok: true, ignored: true });
      const email = await findByMessageId(app.pool, ev.messageId);
      if (!email) return reply.send({ ok: true, unknown: true });
      if (ev.type === 'bounce' || ev.type === 'complaint') {
        await markStatus(app.pool, email.id, ev.type === 'bounce' ? 'bounced' : 'complained');
        await addSuppression(app.pool, { tenantId: email.tenant_id, address: ev.recipient, reason: ev.type });
      }
      reply.send({ ok: true });
    } catch (e) { sendError(reply, new AppError('webhook_failed', 400, (e as Error).message)); }
  });
}
```

- [ ] **Step 3: Implement `server/src/webhooks/mailgun.ts`**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';

interface MailgunEnvelope {
  signature?: { timestamp: string; token: string; signature: string };
  'event-data'?: {
    event: string;
    severity?: string;
    recipient: string;
    message?: { headers?: { 'message-id'?: string } };
  };
}

export function verifyMailgun(body: MailgunEnvelope, cfg: Config): void {
  const sig = body.signature;
  if (!sig) throw new Error('missing signature');
  const key = process.env.MAILGUN_SIGNING_KEY;
  if (!key) throw new Error('MAILGUN_SIGNING_KEY not set');
  const computed = createHmac('sha256', key).update(sig.timestamp + sig.token).digest('hex');
  const a = Buffer.from(computed); const b = Buffer.from(sig.signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('invalid signature');
  // 5 minute window
  if (Math.abs(Date.now() / 1000 - Number(sig.timestamp)) > 300) throw new Error('signature expired');
  void cfg;
}

export function parseMailgunEvent(body: MailgunEnvelope): {
  type: 'bounce' | 'complaint' | 'delivery'; messageId: string; recipient: string;
} | null {
  const e = body['event-data']; if (!e) return null;
  const messageId = (e.message?.headers?.['message-id'] ?? '').replace(/^<|>$/g, '');
  if (!messageId) return null;
  if (e.event === 'failed' && e.severity === 'permanent') return { type: 'bounce', messageId, recipient: e.recipient };
  if (e.event === 'complained') return { type: 'complaint', messageId, recipient: e.recipient };
  if (e.event === 'delivered') return { type: 'delivery', messageId, recipient: e.recipient };
  return null;
}
```

- [ ] **Step 4: Tests for SES + Mailgun parsing (signature verify mocked)** in `server/test/bounce.ses.test.ts` and `server/test/bounce.mailgun.test.ts`.

```ts
// bounce.ses.test.ts (excerpt — focused on the parser, signature verify mocked)
import { describe, it, expect } from 'vitest';
import { parseSesNotification } from '../src/webhooks/ses.js';

describe('parseSesNotification', () => {
  it('extracts permanent bounce recipients', () => {
    const msg = JSON.stringify({
      notificationType: 'Bounce',
      mail: { messageId: 'abc' },
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'r@x.com' }] },
    });
    expect(parseSesNotification(msg)).toEqual({ type: 'bounce', messageId: 'abc', recipients: ['r@x.com'] });
  });
  it('ignores soft bounces', () => {
    const msg = JSON.stringify({
      notificationType: 'Bounce',
      mail: { messageId: 'abc' },
      bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'r@x.com' }] },
    });
    expect(parseSesNotification(msg)).toBeNull();
  });
});
```

- [ ] **Step 5: Wire in `app.ts`** — `await registerV1WebhookRoutes(app);` before ctx middleware blocks `/v1/*`. The ctx middleware already early-returns for `/v1/webhooks/`.
- [ ] **Step 6: Commit.**

```bash
npm -w server test
git add . && git commit -m "feat(webhooks): SES + Mailgun bounce/complaint ingestion"
```

### Task 13.2: Suppressions routes (UI CRUD)

**Files:** Create `server/src/routes/suppressions.ts`, test mirrors senders test

- [ ] **Step 1: Implement**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { sendError, AppError } from '../util/errors.js';
import { addSuppression, listSuppressions, removeSuppression } from '../repos/suppressions.js';

const AddBody = z.object({ address: z.string().email(), reason: z.enum(['bounce','complaint','manual']).default('manual') });

export async function registerSuppressionRoutes(app: FastifyInstance) {
  app.get('/api/suppressions', async (req, reply) => {
    try { const ctx = requireTenantCtx(req); reply.send({ suppressions: await listSuppressions(app.pool, ctx.tenantId) }); }
    catch (e) { sendError(reply, e); }
  });
  app.post('/api/suppressions', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const body = AddBody.parse(req.body);
      await addSuppression(app.pool, { tenantId: ctx.tenantId, ...body });
      reply.code(201).send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });
  app.delete('/api/suppressions/:address', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { address } = req.params as { address: string };
      const ok = await removeSuppression(app.pool, ctx.tenantId, decodeURIComponent(address));
      if (!ok) throw new AppError('not_found', 404, 'Suppression not found');
      reply.send({ ok: true });
    } catch (e) { sendError(reply, e); }
  });
}
```

- [ ] **Step 2: Wire, commit.**

```bash
git add . && git commit -m "feat(api): suppressions CRUD"
```

---

# Phase 14 — UI read endpoints (email log)

### Task 14.1: GET /api/emails + detail

**Files:** Create `server/src/routes/emails.ts`

- [ ] **Step 1: Implement**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '../auth/ctx.js';
import { sendError, AppError } from '../util/errors.js';
import { getEmail, listEmails, type EmailStatus } from '../repos/emails.js';

export async function registerEmailRoutes(app: FastifyInstance) {
  app.get('/api/emails', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const q = z.object({
        status: z.string().optional(),
        since: z.coerce.date().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }).parse(req.query);
      const list = await listEmails(app.pool, ctx.tenantId, {
        status: q.status as EmailStatus | undefined, since: q.since, limit: q.limit,
      });
      reply.send({ emails: list });
    } catch (e) { sendError(reply, e); }
  });
  app.get('/api/emails/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      const { id } = req.params as { id: string };
      const e = await getEmail(app.pool, ctx.tenantId, id);
      if (!e) throw new AppError('not_found', 404, 'Email not found');
      reply.send({ email: e });
    } catch (e) { sendError(reply, e); }
  });
}
```

- [ ] **Step 2: Wire, commit.**

```bash
git add . && git commit -m "feat(api): UI read endpoints for emails"
```

---

## Plan B — Self-review

- **Spec coverage:** Acceptance criteria #3 (immediate send), #4 (scheduled), #5 (failed retries with error), #6 (bounce → status + suppression), #7 (suppressed pre-check) are implemented. #9 (encryption) was already in Plan A; Plan B confirms it via worker decryption path. UI / docker / final acceptance live in Plan C.
- **Type consistency:** `EmailStatus`, `EmailRow`, `SendInputT` defined once and reused.
- **Placeholders:** none. SES SubscriptionConfirmation auto-confirm is logged for the operator to GET out-of-band — explicit, not a TODO.

## Acceptance for Plan B

1. All `npm -w server test` green.
2. End-to-end via curl: create tenant + sender + smtp config (smtp-tester) + api key → POST /v1/emails → status transitions queued → sent in DB.
3. POST /v1/emails with `scheduled_for` 1 minute in the future → status `queued` → after 60s, status `sent`.
4. POST /v1/webhooks/bounce/ses with crafted SES Notification matching a known message_id → email becomes `bounced`, address added to suppressions.
5. Send to a suppressed address → response says `status: "suppressed"`, no SMTP call.
