# AIployee Emailer — Design Spec

**Date:** 2026-05-14
**Status:** Draft for review
**Owner:** Liam (AIployee)
**Built for:** AIployee — internal tool serving AIployee's own automation workflows and AIployee's clients. Branding, copy, and styling all match aiployee.co.za. Not a generic product.

## Purpose

A multi-tenant transactional email service that AIployee owns and operates. Provides:

- A REST API that AIployee's automation workflows (and the workflows AIployee builds for its clients) call to send email — call summaries, booking confirmations, follow-ups, etc.
- A web UI where AIployee staff onboard client tenants, and where each tenant's users manage their own senders, templates, SMTP credentials, API keys, and email logs.

Optimised for **cheap to run and easy for AIployee to operate** on a single small VPS.

## Cost (TL;DR for the CEO)

This is deliberately a **~$5/month** build, not a SaaS spend.

| Item | Monthly | Notes |
|------|---------|-------|
| Hetzner CX11 VPS (2 vCPU, 4 GB) | ~$5 | Runs everything: app + Postgres + Caddy in three containers. |
| TLS certificate | $0 | Caddy auto-issues from Let's Encrypt. |
| Database | $0 | Postgres in-container on the same VPS. No managed-DB fee. |
| Queue / scheduler | $0 | pg-boss inside Postgres. No Redis, no SQS. |
| Email delivery | $0 to AIployee | Each tenant brings their own SMTP credentials (their SES, Mailgun, etc.). AIployee does not pay for or pass through email-send costs in v1. |
| Domain (re-use) | $0 incremental | Subdomain of aiployee.co.za. |
| Backups | ~$1 | Optional weekly `restic` push to S3-compatible storage. |
| **Total to AIployee** | **~$5–6/mo** | Flat regardless of tenant count at v1 volumes (low thousands of emails/day). |

No per-seat licensing, no managed services, no third-party vendors required. Scaling later (Redis, separate worker container, managed Postgres) is opt-in once volume justifies it.

## Non-goals (v1)

- Self-serve signup / billing.
- SSO / OAuth login.
- Marketing-style campaigns, list management, or unsubscribe pages.
- Inbound email parsing.
- Multi-region HA.
- Reselling email-sending capacity (tenants pay their own SMTP provider).

## Non-goals (v1)

- Self-serve signup / billing.
- SSO / OAuth login.
- Marketing-style campaigns, list management, or unsubscribe pages.
- Inbound email parsing.
- Multi-region HA.

## Constraints

- Must run on a single small VPS (~$5/month, e.g. Hetzner CX11) with room to grow.
- Visual style of the UI must match `aiployee.co.za` (palette, typography, tone). Exact tokens captured during implementation by inspecting the live site.
- Tenants bring their own SMTP credentials (any provider). No shared sending infrastructure.
- All sender SMTP credentials must be encrypted at rest.

## Architecture

Single docker-compose stack on one VPS:

```
┌─────────────────────────────────────────┐
│ VPS                                     │
│  ┌────────┐   ┌──────────────────┐     │
│  │ caddy  │──▶│ app (Node)       │     │
│  │  TLS   │   │  • Fastify API   │     │
│  └────────┘   │  • Static UI     │     │
│               │  • pg-boss worker│     │
│               └────────┬─────────┘     │
│                        ▼                │
│                ┌──────────────┐         │
│                │  postgres    │         │
│                │  (data +     │         │
│                │   queue +    │         │
│                │   sessions)  │         │
│                └──────────────┘         │
└─────────────────────────────────────────┘
                  │
                  ▼ (per-tenant SMTP)
              SES / Mailgun / etc
```

Three containers: `caddy`, `app`, `postgres`. The app is one Node process running Fastify (HTTP API + static UI) and pg-boss (queue + scheduled sends) in the same runtime. Volume from Postgres mounted to host for backups.

**Why one process:** keeps deployment, logging, and resource use trivial. At expected v1 volume (low thousands/day across all tenants) a single Node process is well within budget. Splitting the worker into its own container is a one-file change later if needed.

**Why pg-boss over BullMQ/Redis:** removes Redis as a dependency. One database to back up, monitor, and reason about. pg-boss provides delayed jobs, retries with backoff, and crash safety — sufficient for this workload.

## Tech stack

| Layer       | Choice                                    |
|-------------|-------------------------------------------|
| Runtime     | Node.js 24 LTS                            |
| HTTP        | Fastify 5 (built-in JSON schema validation)|
| Auth        | bcrypt + cookie sessions (`@fastify/session` + `connect-pg-simple`-equivalent) |
| DB          | Postgres 16                               |
| Migrations  | `node-pg-migrate`                         |
| Queue       | pg-boss (in-process)                      |
| SMTP        | Nodemailer                                |
| UI          | React 18 + Vite, built to `server/public` |
| UI routing  | react-router-dom                          |
| UI styling  | Tailwind CSS, with palette from aiployee.co.za |
| Validation  | Zod (shared schemas server + client)      |
| Encryption  | AES-256-GCM (Node `crypto`), key from env |
| Reverse proxy | Caddy 2 (auto-TLS via Let's Encrypt)    |

## Data model

```sql
tenants(
  id            uuid pk,
  name          text not null,
  slug          text unique not null,
  created_at    timestamptz default now()
)

users(
  id            uuid pk,
  tenant_id     uuid null references tenants,        -- null only for super_admin
  email         text not null,
  password_hash text not null,
  role          text not null,                        -- 'super_admin'|'tenant_admin'|'tenant_user'
  invite_token  text null,
  invite_expires_at timestamptz null,
  created_at    timestamptz default now(),
  unique (tenant_id, email)
)

smtp_configs(
  id                  uuid pk,
  tenant_id           uuid not null references tenants,
  name                text not null,                  -- 'SES production', 'Mailgun staging'
  host                text not null,
  port                int  not null,
  secure              bool not null default false,
  username            text not null,
  password_encrypted  bytea not null,                 -- AES-256-GCM
  from_domain         text not null,                  -- hint, not enforced
  is_default          bool not null default false,
  created_at          timestamptz default now(),
  unique (tenant_id, name)
)

senders(
  id              uuid pk,
  tenant_id       uuid not null references tenants,
  email           text not null,
  display_name    text not null,
  reply_to        text null,
  smtp_config_id  uuid not null references smtp_configs,
  is_default      bool not null default false,
  created_at      timestamptz default now(),
  unique (tenant_id, email)
)

templates(
  id              uuid pk,
  tenant_id       uuid not null references tenants,
  name            text not null,
  subject         text not null,
  body_html       text not null,
  body_text       text null,
  variables       jsonb not null default '[]',        -- auto-detected list
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  unique (tenant_id, name)
)

api_keys(
  id              uuid pk,
  tenant_id       uuid not null references tenants,
  name            text not null,
  key_hash        text unique not null,
  key_prefix      text not null,                      -- e.g. 'aip_live_abcd'
  created_at      timestamptz default now(),
  last_used_at    timestamptz null,
  revoked_at      timestamptz null
)

emails(
  id              uuid pk,
  tenant_id       uuid not null references tenants,
  sender_id       uuid not null references senders,
  to_addr         text not null,
  cc              text[] not null default '{}',
  bcc             text[] not null default '{}',
  reply_to        text null,
  subject         text not null,
  body_html       text not null,
  body_text       text null,
  template_id     uuid null references templates,
  attachments     jsonb not null default '[]',
  status          text not null,                      -- queued|sending|sent|failed|bounced|complained|suppressed
  scheduled_for   timestamptz null,
  sent_at         timestamptz null,
  error           text null,
  message_id      text null,
  api_key_id      uuid null references api_keys,
  created_at      timestamptz default now()
)
create index on emails (tenant_id, created_at desc);
create index on emails (status, scheduled_for) where status = 'queued';

bounce_events(
  id            uuid pk,
  email_id      uuid not null references emails,
  type          text not null,                        -- 'bounce'|'complaint'|'delivery'
  raw_payload   jsonb not null,
  received_at   timestamptz default now()
)

suppressions(
  id            uuid pk,
  tenant_id     uuid not null references tenants,
  address       text not null,
  reason        text not null,                        -- 'bounce'|'complaint'|'manual'
  created_at    timestamptz default now(),
  unique (tenant_id, address)
)

sessions(
  sid       text pk,
  sess      jsonb not null,
  expire    timestamptz not null
)
```

Every tenant-scoped table includes `tenant_id`. All repository functions take a `ctx` containing the active `tenant_id` and embed it in every query. Direct DB access without `ctx` is forbidden by convention and code-review.

## API surface

### Tenant API (`Authorization: Bearer aip_…`)

| Method | Path | Body | Notes |
|--------|------|------|-------|
| POST | `/v1/emails` | `{ from, to, cc?, bcc?, reply_to?, subject?, html?, text?, template?, variables?, attachments?, scheduled_for? }` | `from` matches a sender. Either `subject+html` or `template+variables`. Returns `{ id, status }`. |
| GET  | `/v1/emails/:id` | — | Status lookup. |
| GET  | `/v1/emails` | `?status=&since=&limit=` | Tenant-scoped list. |
| POST | `/v1/webhooks/bounce/:provider` | provider payload | Public, signature-verified. Updates email status, writes `bounce_events`, adds suppression. |

Errors follow `{ error: { code, message, details? } }` with stable codes (`invalid_sender`, `template_not_found`, `suppressed`, etc).

### UI API (session cookie auth, CSRF on writes)

- `POST /auth/login`, `POST /auth/logout`
- `POST /auth/invite/accept` (token + new password)
- Tenant-scoped CRUD: `/api/senders`, `/api/templates`, `/api/smtp-configs`, `/api/api-keys`, `/api/users`, `/api/suppressions`
- Read-only: `/api/emails`, `/api/emails/:id`
- Test: `POST /api/smtp-configs/:id/test` — sends a probe to a user-supplied address.
- Super-admin only: `/api/admin/tenants` (list/create), `/api/admin/tenants/:id/invite`

## Auth and tenant isolation

- **Sessions:** signed cookies, server-side store in the `sessions` table. 7-day rolling expiry.
- **CSRF:** double-submit token on all non-GET UI requests.
- **Passwords:** bcrypt cost 12. Forced rotation on first login after invite.
- **API keys:** generated as `aip_live_<32 chars>`, only `sha256(key)` stored. Prefix shown in UI.
- **Context middleware:** every request resolves to a `req.ctx = { tenantId, userId|apiKeyId, role }`. The repository layer accepts `ctx` and ALWAYS adds `tenant_id = $ctx.tenantId` to queries. A super-admin context bypasses the filter only on explicitly admin-tagged repository methods.
- **Encryption:** SMTP passwords AES-256-GCM with a 32-byte key from `EMAILER_ENC_KEY` env. Each row stores `iv || authTag || ciphertext`. Key rotation handled by re-encrypt migration when needed.

## Sending pipeline

1. API receives `POST /v1/emails`.
2. Validate: sender exists for tenant, recipient not in `suppressions`, template exists if named, attachments under 10 MB total.
3. Render: if `template`, run a tiny `{{var}}` substitution against `variables` (no logic, no partials — strict). Auto-extract `{{vars}}` from template body on save.
4. Insert into `emails` with `status='queued'`. If `scheduled_for` in the future, that's the only persistence step.
5. Otherwise enqueue a pg-boss job referencing the email id.
6. Worker picks up job, sets `status='sending'`, looks up SMTP config, decrypts password, calls Nodemailer.
7. On success: `status='sent'`, `message_id` from SMTP response.
8. On transient failure (4xx/5xx, timeout): pg-boss retries with exponential backoff up to 5 attempts, then `status='failed'` with last error.
9. A pg-boss scheduled job runs every 30s, claims `emails WHERE status='queued' AND scheduled_for <= now()`, and enqueues them.

## Bounces

- Per-provider webhook endpoint: `/v1/webhooks/bounce/ses`, `/v1/webhooks/bounce/mailgun`, etc.
- Verify provider signature.
- Match to email by `message_id` (stored in step 7 above).
- Insert into `bounce_events`, update `emails.status`, upsert into `suppressions` for hard bounces and complaints.
- Outbound sends pre-check `suppressions` and reject with `status='suppressed'` (logged, never enqueued).

## UI screens

| # | Screen | Notes |
|---|--------|-------|
| 1 | Login | Email + password. Forgot-password sends reset link via tenant's default SMTP config (Aiployee config for super-admin). |
| 2 | Accept invite | Token in URL, set password, land on dashboard. |
| 3 | Dashboard | Sends today (sent/failed/queued/bounced), 24h sparkline, last 10 emails. |
| 4 | Senders | Table; add/edit form picks an SMTP config; show DKIM/SPF guidance text per provider. |
| 5 | Templates | List + edit. Edit page: subject input, two textareas (HTML, text fallback), live preview iframe, auto-detected variables list. |
| 6 | SMTP configs | List; add/edit; "Send test" button. |
| 7 | Email log | Filterable table (status, sender, date), row click opens detail drawer (full headers, body preview, error). |
| 8 | API keys | List shows name + prefix + last used. "Generate" reveals full key once in a copy box. |
| 9 | Users (tenant admin) | Invite by email, set role, revoke. |
| 10 | Super admin | Tenants list, create tenant, invite first tenant_admin. |

### Styling

- Tailwind CSS configured with palette and typography pulled from `aiployee.co.za` (captured during implementation by inspecting the live site's compiled CSS).
- Layout: top nav + left sidebar in app, full-width landing for login/invite.
- Responsive down to 768px. Mobile is not a primary target.

## Repo layout

```
/server          Fastify app (routes, repositories, auth, worker handlers)
  /public        built UI (gitignored)
/web             Vite + React UI source
/shared          Zod schemas + TS types shared by server and web
/db              SQL migrations
/docker          Dockerfile per service, docker-compose.yml, Caddyfile
/docs            this spec, runbooks
package.json     workspaces: server, web, shared
```

## Operations

- **Backups:** nightly `pg_dump` to a host volume; weekly off-host copy via `restic` to S3-compatible storage.
- **Logs:** Fastify pino JSON to stdout, `docker logs` is the audit trail; rotate via journald.
- **Metrics:** v1 is logs-only. Add `/metrics` Prometheus endpoint when needed.
- **Deploy:** `git pull && docker compose up -d --build` on the VPS. CI later.
- **Secrets:** `.env` on the VPS (chmod 600), loaded by docker compose. `EMAILER_ENC_KEY`, `SESSION_SECRET`, DB credentials.

## Open questions / deferred

- Which SMTP providers get bounce-webhook support in v1: SES + Mailgun proposed; others can land later.
- Rate limiting per API key — added in v1.1 once we see real traffic patterns.
- Audit log of admin actions — deferred to v1.1.

## Acceptance criteria for v1

1. Super-admin can create a tenant and invite its first admin via UI.
2. Tenant admin can: log in, add SMTP config, add sender, send a test, create a template.
3. API call with a valid key sends an email immediately and returns an id.
4. API call with `scheduled_for` in the future sends at that time (within 1 minute).
5. Failed sends retry with backoff and end up in the email log with the SMTP error.
6. Webhook from SES/Mailgun marks the email bounced/complained and adds the address to suppressions.
7. A subsequent send to a suppressed address is rejected with `status='suppressed'`.
8. Tenant A's UI never sees Tenant B's data; a Tenant A API key cannot send as a Tenant B sender.
9. SMTP passwords in `smtp_configs` are unreadable without `EMAILER_ENC_KEY`.
10. The whole stack runs on a single VPS via `docker compose up`.
