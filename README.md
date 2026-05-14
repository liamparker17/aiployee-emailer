# AIployee Emailer

**The internal email-sending tool that lets AIployee charge clients for outcomes — booking confirmations, call summaries, follow-ups — without paying for a SaaS in between.**

---

## Why AIployee built this

Every workflow AIployee builds for a client ends in an email. Booking confirmed, call summarised, lead followed up, invoice sent. Until now those emails had to go through a third-party service (Postmark, SendGrid, Mailgun's UI, Mandrill, Customer.io) — each one charging per-tenant fees, per-email fees, or both, and forcing AIployee to either eat the cost or pass it through and explain a separate bill to the client.

The AIployee Emailer flips that:

- **AIployee owns the platform.** One service, one VPS, one operator (us). No SaaS vendor sitting between AIployee and its clients.
- **Clients keep their own SMTP credentials.** Each client tenant plugs in their own AWS SES / Mailgun / Postmark account — so deliverability reputation and email-send costs stay on **their** bill, not ours. AIployee never resells email-send capacity, which keeps this out of "email service provider" pricing territory.
- **Workflows authenticate with a per-tenant API key.** AIployee's automation stack (n8n, Zapier, custom workflows) calls `POST /v1/emails` with a Bearer token. Clients can also be given the key to use directly.
- **Clients get a branded admin UI.** Senders, templates, logs, suppressions — all under a subdomain of aiployee.co.za, styled to match aiployee.co.za. The product itself becomes a touchpoint for AIployee.
- **Total operational cost: ~$5/month flat**, regardless of how many clients are on it. Adding the tenth client doesn't add a tenth bill.

### What it replaces and what it costs to replace

| Service | Typical cost at AIployee scale | What it gave us | What we lose by self-hosting |
|---|---|---|---|
| **Brevo** (was Sendinblue) | $9/mo Starter (5k emails/mo) → $18/mo Business (20k) → enterprise pricing past that. **Per-account, not per-tenant** — every AIployee client either needs their own Brevo account (you manage 10 dashboards) or shares one (deliverability reputation cross-contaminates between clients). | API, templates, basic contacts, transactional + marketing in one tool | Nothing for transactional. Brevo's marketing-list tooling is not built here (out of scope for v1). |
| Postmark / SendGrid (per-tenant) | $15–50/mo per client | A UI, an API, deliverability | Nothing — clients still bring their own SMTP, we just own the UX layer |
| Mailgun multi-account | ~$35/mo + per-email | API + bounce handling | Nothing — bounce webhooks built in |
| Customer.io / Mandrill | $100+/mo | Templates, scheduling | Nothing — templates + scheduled sends built in |
| **AIployee Emailer** | **~$0–5/mo total** (Vercel free tier covers v1; ~$5 if you VPS-host) | All of the above for transactional, AIployee-branded, **truly per-tenant** | Vendor SLA — but AIployee is the operator either way |

**Specifically vs Brevo:**
- Brevo at 10 clients × 5,000 emails/mo each = 10 × $9/mo = **$90/mo** with separate accounts (and 10 dashboards to manage), or one shared account with mixed sender reputation.
- AIployee Emailer at the same volume = **$0/mo** on Vercel free tier (up to ~100k function invocations/month). Each client's SMTP credentials are isolated; their deliverability reputation stays on their own SES/Mailgun/Brevo account.
- Brevo locks templates and contacts to their UI. AIployee Emailer's templates live in our Postgres — readable, exportable, version-controllable.
- Brevo charges per email above the included volume. AIployee Emailer doesn't — we don't touch the email-send bill at all (tenant's SMTP provider does).

Break-even vs even one client on Brevo Starter: month one.

## Cost (TL;DR for the CEO)

| Item | Monthly | Notes |
|------|---------|-------|
| Hetzner CX11 VPS (2 vCPU, 4 GB) | ~$5 | App + Postgres + Caddy in three containers |
| TLS certificate | $0 | Caddy auto-issues from Let's Encrypt |
| Database | $0 | Postgres in-container; no managed-DB fee |
| Queue / scheduler | $0 | pg-boss inside Postgres; no Redis, no SQS |
| Email delivery | $0 to AIployee | Tenants bring their own SMTP credentials |
| Domain | $0 incremental | Subdomain of aiployee.co.za |
| Backups | ~$1 | Optional weekly `restic` to S3-compatible storage |
| **Total to AIployee** | **~$5–6/mo** | Flat regardless of tenant count at v1 volumes (low thousands of emails/day) |

No per-seat licensing, no managed services, no third-party vendors. Scaling later (Redis, separate worker, managed Postgres) is opt-in once volume justifies it.

## What's in v1

- **Multi-tenant.** AIployee staff (super-admin) onboard client tenants and invite their first user.
- **Tenant-managed resources.** Each tenant manages their own senders (e.g. `alex@acme.com`), HTML templates with `{{variable}}` placeholders, SMTP credentials (encrypted at rest with AES-256-GCM), and API keys.
- **REST API.** `POST /v1/emails` for immediate or scheduled send; `GET /v1/emails/:id` for status; suppressions checked pre-send.
- **Immediate sends dispatch inline** in the API request — caller gets `sent`/`failed` synchronously, no waiting on a queue.
- **Bounce handling.** Webhooks for SES (SNS) and Mailgun automatically mark emails bounced/complained and add the recipient to a per-tenant suppression list.
- **Email log.** Per-tenant searchable history with status, error, and full message body.
- **Strict isolation.** A tenant cannot see or affect another tenant's data; cross-tenant attempts return 403/404.

## Throughput & reliability

- **~30,000 emails/hour** at default settings (500 emails per cron tick, 1 tick/minute). Tunable via `CRON_BATCH_SIZE`. Real ceiling is your tenant's SMTP provider's rate limit, not us.
- **Pooled SMTP transports** — one TCP+TLS connection per provider per cron tick, reused across all that provider's emails. No handshake-per-email overhead.
- **Concurrent-safe claim** — `FOR UPDATE SKIP LOCKED` in the queue claim means multiple cron pings (or overlapping ones) never double-send.
- **Retry policy: 1 retry** (2 total attempts: initial + 1 retry), 60s cool-off between attempts. Configurable.
- **Crash recovery** — if a function crashes mid-send, the row sits in `status='sending'` and is auto-requeued by the retry cron after 2 minutes. No manual intervention.

## Architecture

**Stateless Fastify app + Postgres + external cron.** Runs on Vercel (recommended) or any VPS.

```
[ workflow ] ──▶ POST /v1/emails ──▶ Fastify ──▶ SMTP (immediate)
                                       │
                                       ▼
                                    Postgres
                                       ▲
                                       │
[ cron-job.org ] ──▶ POST /v1/cron/process-queue (every 1 min)
                ──▶ POST /v1/cron/retry-failed   (every 5 min)
```

- **Backend:** Node 24 + Fastify 5 + Zod
- **Database:** Postgres 16 (data + sessions; no separate queue/Redis)
- **Sending:** Immediate sends dispatch inline in `POST /v1/emails`; scheduled + retries are driven by external cron hitting `/v1/cron/*`
- **Frontend:** React 18 + Vite + Tailwind, built into `server/public` and served by Fastify
- **TLS:** Vercel automatic, or Caddy 2 on a VPS
- **SMTP:** Nodemailer; each tenant supplies their own SMTP host + credentials

## Quick start (local dev) — one command

```bash
# Linux/macOS
./scripts/bootstrap-dev.sh

# Windows PowerShell
./scripts/bootstrap-dev.ps1
```

The script:
1. Generates `.env` with random `SESSION_SECRET` and `EMAILER_ENC_KEY` if it doesn't exist.
2. Starts dev Postgres via `docker compose -f docker/docker-compose.dev.yml up -d`.
3. Runs `npm install` if needed.
4. Runs migrations.
5. Builds the UI into `server/public`.
6. Creates a super-admin user (default `admin@aiployee.co.za` / `change-me-now`).
7. Tells you to run `npm -w server run dev` and `npm -w web run dev`.

## Quick start (Vercel — recommended)

```bash
# 1. Install Vercel CLI once
npm i -g vercel

# 2. Provision a Postgres database via the Vercel Marketplace (Neon free tier works)
#    Vercel auto-injects DATABASE_URL into your project env.

# 3. Set the rest of the env vars
vercel env add SESSION_SECRET production       # 32+ char random
vercel env add EMAILER_ENC_KEY production      # 32-byte base64 (openssl rand -base64 32)
vercel env add PUBLIC_BASE_URL production      # https://email.aiployee.co.za
vercel env add CRON_SECRET production          # any long random string — paste this into cron-job.org headers

# 4. Deploy
vercel deploy --prod

# 5. Run migrations against the deployed DB
DATABASE_URL=$(vercel env pull .env.tmp >/dev/null && grep ^DATABASE_URL .env.tmp | cut -d= -f2-) \
  npx -w server node-pg-migrate -m server/migrations up && rm .env.tmp

# 6. Bootstrap the first super-admin (one-off via curl against the deployed URL)
#    See scripts/create-super-admin.sh — or run it locally pointed at the prod DATABASE_URL.

# 7. Wire cron-job.org (free tier: https://cron-job.org)
#    Job 1: POST https://email.aiployee.co.za/v1/cron/process-queue   every 1 min
#    Job 2: POST https://email.aiployee.co.za/v1/cron/retry-failed    every 5 min
#    Both jobs need header:  Authorization: Bearer <your CRON_SECRET>
```

## Quick start (production VPS) — three commands

```bash
git clone <this repo> && cd aiployee-emailer/docker
cp .env.example .env && nano .env   # set EMAILER_ENC_KEY, SESSION_SECRET, PUBLIC_HOST
docker compose up -d --build
```

Then bootstrap the first super-admin:

```bash
docker compose exec app node server/dist/bin/createAdmin.js root@aiployee.co.za 'change-me-now'
```

Caddy will auto-issue a TLS certificate for `PUBLIC_HOST` on the first HTTPS request. That's it — visit `https://<PUBLIC_HOST>` and sign in.

Generate the two required secrets (Linux/macOS):

```bash
openssl rand -base64 32   # SESSION_SECRET
openssl rand -base64 32   # EMAILER_ENC_KEY
```

…or PowerShell:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Max 256 }))
```

## Repository layout

```
shared/        Zod schemas + TS types shared between server and web
server/        Fastify app (routes, repositories, auth, worker handlers, migrations)
web/           Vite + React UI (built into server/public on deploy)
docker/        Dockerfile, docker-compose.yml, Caddyfile, .env.example
scripts/       bootstrap-dev.sh / .ps1
docs/
  superpowers/
    specs/     Design spec
    plans/     Implementation plans (A: backend, B: send pipeline, C: UI + docker)
  acceptance/  Acceptance walkthrough for v1
```

## Onboarding a client (5 minutes)

1. Sign in at `https://email.aiployee.co.za` as super-admin.
2. **Tenants → Add** → name, slug, client admin email → click Create.
3. The UI returns an invite URL. Email it to the client.
4. Client clicks the link, sets their password, signs in.
5. Client adds their SMTP config (SES/Mailgun/etc.) → adds a sender → generates an API key.
6. AIployee plugs the API key into the workflow that needs to send email. Done.

## API quick reference

```
Authorization: Bearer aip_live_…    (per-tenant API key)

POST /v1/emails
  { from, to, subject?, html?, template?, variables?, attachments?, scheduled_for? }
  → 202 { id, status, scheduledFor }

GET  /v1/emails/:id                   → email row with current status
GET  /v1/emails?status=&since=&limit= → tenant-scoped list

POST /v1/webhooks/bounce/ses          (SES SNS, signature-verified)
POST /v1/webhooks/bounce/mailgun      (Mailgun, HMAC-verified)
```

Example workflow call (n8n / curl):

```bash
curl -X POST https://email.aiployee.co.za/v1/emails \
  -H "Authorization: Bearer aip_live_…" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "alex@acme.com",
    "to": "lead@example.com",
    "template": "follow_up",
    "variables": { "name": "Casey", "callTime": "Tuesday at 2pm" }
  }'
```

## Status

**Code-complete, not yet production-validated.** All v1 features implemented across Plans A → B → C (see commit history). Before treating this as production-ready for client traffic, the acceptance walkthrough at `docs/acceptance/README.md` must be run end-to-end against a real deployment with screenshots / curl transcripts captured as evidence. Cost figures in this README are projections based on the chosen architecture (single Hetzner CX11 + in-container Postgres), not measured from a deployed instance.

Recommended next step: stand up a controlled internal MVP — one VPS, one AIployee-internal tenant, one real workflow — and run the acceptance checklist before onboarding any external client.

See `docs/superpowers/specs/` for the design spec and `docs/superpowers/plans/` for the implementation plans (A: backend foundation, B: send pipeline, C: UI + Docker).

## License

Proprietary — internal AIployee tool. Not for external distribution.
