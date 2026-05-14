# AIployee Emailer

Internal multi-tenant transactional email service for **AIployee** (aiployee.co.za) and AIployee's clients. Provides a REST API that AIployee's automation workflows call to send email, and a web UI where AIployee staff onboard client tenants and manage senders, templates, SMTP credentials, API keys, and email logs.

> **Built for AIployee, not as a generic SaaS.** Branding, palette and typography are lifted from aiployee.co.za. Hosted on a subdomain of aiployee.co.za and operated by AIployee staff.

## Cost (the important bit)

This is deliberately a **~$5/month** build, not a SaaS spend. No managed services, no per-seat licensing, no Redis, no third-party vendors.

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

Scaling later (Redis, separate worker container, managed Postgres) is opt-in once volume justifies it.

## What it does (v1)

- Multi-tenant: AIployee staff (super-admin) onboard client tenants and invite their first user.
- Tenants manage their own senders (e.g. `alex@acme.com`), HTML templates with `{{variable}}` placeholders, SMTP credentials (encrypted at rest with AES-256-GCM), and API keys.
- REST API: `POST /v1/emails` to send immediately or schedule for later, `GET /v1/emails/:id` for status.
- Bounce/complaint webhooks for SES and Mailgun → automatic per-tenant suppression list.
- Per-tenant email log with status, errors, and full message body.
- Strict tenant isolation (a tenant cannot see or affect another tenant's data).

## Architecture

Three containers on one VPS, fronted by Caddy for TLS:

```
caddy ─▶ app (Fastify API + pg-boss worker + static React UI) ─▶ postgres
```

- **Backend:** Node 24 + Fastify 5 + Zod validation
- **Database:** Postgres 16 (also stores sessions and the pg-boss job queue)
- **Worker:** pg-boss running in-process in the same Node app
- **Frontend:** React 18 + Vite + Tailwind, built into `server/public` and served by Fastify
- **Reverse proxy:** Caddy 2 (auto-TLS via Let's Encrypt)
- **SMTP:** Nodemailer; each tenant supplies their own SMTP host/credentials

## Repository layout

```
shared/        Zod schemas + TS types shared between server and web
server/        Fastify app (routes, repositories, auth, worker handlers, migrations)
web/           Vite + React UI (built into server/public on deploy)
docker/        Dockerfile, docker-compose.yml, Caddyfile, .env.example
docs/
  superpowers/
    specs/     Design spec
    plans/     Implementation plans (A: backend, B: send pipeline, C: UI + docker)
```

## Getting started (local dev)

```bash
# 1. Bring up Postgres for development
docker compose -f docker/docker-compose.dev.yml up -d

# 2. Install workspace deps
npm install

# 3. Run migrations
DATABASE_URL=postgres://emailer:emailer@localhost:5433/emailer \
  npx -w server node-pg-migrate -m server/migrations up

# 4. Start the dev server (API on :3000, Vite on :5173)
cp docker/.env.example .env   # then fill in EMAILER_ENC_KEY and SESSION_SECRET
npm -w server run dev
npm -w web run dev   # in a second terminal
```

Generate the two required secrets:

```bash
openssl rand -base64 32   # SESSION_SECRET
openssl rand -base64 32   # EMAILER_ENC_KEY (32-byte AES key)
```

## Deploying to a VPS

```bash
# On the VPS:
git clone <this repo>
cd <repo>/docker
cp .env.example .env
# Fill in EMAILER_ENC_KEY, SESSION_SECRET, PUBLIC_HOST, PUBLIC_BASE_URL
docker compose up -d --build

# Bootstrap the first super-admin (AIployee staff):
docker compose exec app \
  node server/dist/bin/createAdmin.js root@aiployee.co.za 'change-me-now'
```

Caddy will auto-issue a TLS cert for `PUBLIC_HOST` on first request.

## API quick reference

```
Authorization: Bearer aip_live_…    (per-tenant API key)

POST /v1/emails
  { from, to, subject?, html?, template?, variables?, attachments?, scheduled_for? }
  → 202 { id, status, scheduledFor }

GET  /v1/emails/:id                  → email row with current status
GET  /v1/emails?status=&since=&limit= → tenant-scoped list

POST /v1/webhooks/bounce/ses        (SES SNS, signature-verified)
POST /v1/webhooks/bounce/mailgun    (Mailgun, HMAC-verified)
```

## Status

Spec and implementation plans are in `docs/superpowers/`. Implementation in progress against the plans (A → B → C).

## License

Proprietary — internal AIployee tool. Not for external distribution.
