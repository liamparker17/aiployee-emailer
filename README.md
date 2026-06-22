# AIployee Emailer

**The internal email-sending tool that lets AIployee charge clients for outcomes — booking confirmations, call summaries, follow-ups — without paying for a SaaS in between.**

🟢 **Live:** https://aiployee-emailer.vercel.app

> **Part of a monorepo.** This is one of **two frontends** sharing a single Fastify backend and Supabase Postgres database. This README covers the **Emailer** (email sending, templates, SMTP, campaigns, admin). Its sibling, the **[Command Centre](apps/command-centre/README.md)** (`aiployee-command-centre.vercel.app`), is the omnichannel/voice cockpit — Abe, the Call Analytics Center, outbound call campaigns, and flows. The two apps are joined by single-use HMAC **SSO handoff** (see [Cross-app SSO](#cross-app-sso--the-command-centre)).

---

## Why AIployee built this

Every workflow AIployee builds for a client ends in an email. Booking confirmed, call summarised, lead followed up, invoice sent. Until now those emails had to go through a third-party service (Brevo, Postmark, SendGrid, Mailgun, Customer.io) — each charging per-tenant fees, per-email fees, or both, and forcing AIployee to either eat the cost or pass it through and explain a separate bill to every client.

The AIployee Emailer flips that:

- **AIployee owns the platform.** One service, one Vercel project, one operator (us). No SaaS vendor sitting between AIployee and its clients.
- **Clients keep their own SMTP credentials.** Each tenant plugs in their own SES / Mailgun / Brevo SMTP — so deliverability reputation and email-send costs stay on **their** bill, not ours. AIployee never resells email-send capacity.
- **Workflows fire it directly via a webhook step.** Jobix automations (or anything that can POST JSON) hit `POST /v1/emails` with a per-tenant API key. No special integration registration required — it's just a webhook target.
- **Clients get a branded admin UI** for managing senders, templates, SMTP credentials, API keys, and the email log. Lives at `https://aiployee-emailer.vercel.app`, styled to match aiployee.co.za.

## Cost (TL;DR for the CEO)

This runs on Vercel's free tier today. **~$0/month** in operating cost at v1 volumes.

| Item | Monthly | Notes |
|------|---------|-------|
| Vercel Hobby (Functions + static hosting) | $0 | Up to ~100k function invocations/month included; one invocation = one API call or one cron tick. v1 transactional volume sits well inside this. |
| Supabase Postgres (Free tier) | $0 | Pooled via Supavisor (transaction pooler); the free tier comfortably covers v1's sub-GB dataset. |
| TLS + custom domain | $0 | Vercel auto-issues. |
| cron-job.org (queue + retry trigger) | $0 | Free tier; min 1-minute interval. |
| Email delivery | $0 to AIployee | Each tenant brings their own SMTP credentials. AIployee never pays for or passes through email send costs. |
| **Total to AIployee** | **~$0/mo** | Until volume forces an upgrade (Vercel Pro at $20/mo handles ~10× this). |

### What it replaces and what it costs to replace

| Service | Typical cost at AIployee scale | What we lose by self-hosting |
|---|---|---|
| **Brevo** (was Sendinblue) | $9/mo Starter (5k/mo) → $18/mo Business (20k) → enterprise. **Per-account, not per-tenant.** 10 clients = 10 Brevo accounts to manage, OR one shared account where deliverability reputation cross-contaminates between clients. | Brevo's marketing-list tooling (out of scope for v1 anyway). |
| Postmark / SendGrid (per-tenant) | $15–50/mo per client | Nothing — clients still bring their own SMTP, we just own the UX layer. |
| Mailgun (managed multi-account) | ~$35/mo + per-email | Nothing — bounce webhooks built in. |
| Customer.io / Mandrill | $100+/mo | Nothing — templates + scheduled sends built in. |
| **AIployee Emailer** | **~$0/mo** at v1 volumes | Vendor SLA — but AIployee is the operator either way. |

Break-even vs even one client on Brevo Starter: month one.

## What's in v1

- **Multi-tenant.** AIployee staff (super-admin) onboard client tenants and invite their first user.
- **Tenant-managed resources.** Each tenant manages their own senders (e.g. `alex@acme.com`), HTML templates with `{{variable}}` placeholders, SMTP credentials (encrypted at rest with AES-256-GCM), and API keys.
- **REST API.** `POST /v1/emails` for immediate or scheduled send; `GET /v1/emails/:id` for status; per-tenant suppressions checked pre-send.
- **Immediate sends dispatch inline** in the API request — caller gets `sent`/`failed` synchronously, no queue wait.
- **Scheduled & retry via external cron.** No always-on worker process; cron-job.org pings two endpoints every minute. App is fully stateless on Vercel Functions.
- **Bounce handling.** Webhooks for SES (SNS) and Mailgun automatically mark emails bounced/complained and add the recipient to a per-tenant suppression list.
- **Email log.** Per-tenant searchable history with status, error, and full message body.
- **Strict isolation.** A tenant cannot see or affect another tenant's data.

## Campaigns (bulk email + reply intelligence)

Beyond one-off transactional sends, tenant admins can run **bulk email campaigns** from the admin UI (the **Campaigns** and **Launch Campaign** pages) — same bring-your-own-SMTP model, just fanned out to a recipient list and pushed through the existing queue.

- **Launch flow.** Pick a sender + template (or write HTML inline), supply a recipient list with `{{variable}}` merge fields, optionally attach a PDF, and launch. Each recipient becomes a normal queued email, so campaigns inherit pooled SMTP, pre-send suppression checks, retries, and the email log.
- **PDF attachments via Vercel Blob.** Attachments upload straight from the browser to a **public** Vercel Blob store; the campaign stores the blob **URL** and Nodemailer fetches it at send time — so attachment bytes never hit Vercel’s ~4.5 MB function-body limit (25 MB/file, PDF only).
- **One-click unsubscribe.** Every campaign email carries a per-recipient `GET/POST /v1/unsubscribe/:token` link (public, no auth) that adds the address to the tenant’s suppression list.
- **Reply intelligence (Abe).** Inbound replies are correlated back to their campaign; Abe then triages them — bucketing reply intent/sentiment, flagging **hot leads**, and rendering an **outcome-first report** (hot leads → reply triage → Abe handoff) on the campaign page. The `/v1/cron/analyze-replies` cron (~every 15 min) runs this automatically for any campaign with new correlated replies, instead of waiting for someone to ask Abe in chat. Requires the tenant’s OpenAI key.

Campaign management is admin-gated and **session-authenticated** (the `/api/campaigns/*` routes) — it is not part of the per-tenant `/v1` API-key surface.

## Call intelligence (Abe & the Call Analytics Center)

Beyond transactional email, the platform now doubles as an **agentic call database**. Voice/WhatsApp agents (e.g. Jobix) post each completed call's structured outcome to a webhook; the platform stores it as a first-class **call record**, and tenants explore and act on those calls in-app.

- **Structured call ingest.** `POST /v1/jobix/calls` (per-tenant API key, same auth as `/v1/emails`) captures the full Jobix post-call payload — caller identity, summary, outcome, sentiment, callback/escalation flags, duration, and the tenant-specific `values` bag — into a `call_facts` record (one per inbound call, idempotent on the call reference). A per-tenant `attribution_map` resolves which department/agent/line a call belongs to. *(Legacy path: call summaries sent through `POST /v1/emails` are still mirrored into the call pipeline when a tenant opts in.)*
- **Call Analytics Center.** The tenant **Calls** page gives a big-picture dashboard — volumes by **department × reason**, outcome and sentiment mix, resolution and first-call-resolution rates, callbacks, escalations — and an **Excel-style grid** of individual calls: sortable, filterable on every structured dimension, drill-down detail, and CSV export.
- **Abe, the call-line analyst.** An AI employee reads the call line, flags spikes / complaints / urgent cases, and drafts client-facing updates and callback handovers. Every outbound message is gated by human approval — Abe never auto-sends.

All call features are admin-gated per tenant (`tenant_admin` / `super_admin`) and isolated like everything else.

## Throughput & reliability

- **~30,000 emails/hour** at default settings (500 emails per cron tick, 1 tick/min). Tunable via `CRON_BATCH_SIZE`. Real ceiling is the tenant's SMTP provider's rate limit, not us.
- **Pooled SMTP transports.** One TCP+TLS handshake per provider per tick, reused across all that provider's emails.
- **Concurrent-safe claim.** `FOR UPDATE SKIP LOCKED` in the queue claim — multiple cron pings (or overlapping ones) never double-send.
- **Retry policy: 1 retry** (2 total attempts: initial + 1 retry), 60s cool-off.
- **Crash recovery.** If a function crashes mid-send, the row sits in `status='sending'` and is auto-requeued by the retry cron after 2 minutes.

## Architecture

```
[ Jobix workflow ] ─POST /v1/emails─▶ [ Vercel Function (Fastify) ] ─SMTP─▶ tenant's SES/Mailgun/etc
                                            │
                                            ▼
                                       [ Supabase Postgres ]
                                            ▲
                                            │
[ cron-job.org ] ─POST /v1/cron/process-queue   (every 1 min)─┐
                ─POST /v1/cron/retry-failed     (every 1 min)─┘
```

- **Backend:** Node 24 + Fastify 5 + Zod, deployed as a single Vercel Function (Fluid Compute, 300s max duration).
- **Database:** Supabase Postgres (serverless) — connections fan in through Supabase's **Supavisor transaction pooler** (pool capped at 10/instance), TLS verified against a pinned Supabase Root 2021 CA. Holds data + sessions; no separate queue/Redis.
- **Sending:** Immediate sends dispatch inline in `POST /v1/emails`. Scheduled + retries are driven by external cron (cron-job.org) hitting `/v1/cron/*` endpoints.
- **Frontend:** React 18 + Vite + Tailwind, built into `server/public` and served by the same Fastify instance.
- **TLS + domain:** Vercel automatic.
- **SMTP:** Nodemailer; each tenant supplies their own SMTP host + credentials.

## Repository layout

This is an npm-workspaces monorepo: one shared backbone, two deployable frontends.

```
packages/
  shared/      @aiployee/shared — Zod schemas + TS types
  core/        @aiployee/core   — auth, config (env schema), cross-app SSO handoff, shared routes
  ui/          @aiployee/ui     — shared React kit (AuthProvider, TenantSwitcher, Logo, theme)
server/
  src/         Fastify app (routes, repos, auth, send pipeline, dispatch) — the ONE backend both apps run
  migrations/  node-pg-migrate SQL migrations
  public/      built Emailer UI (gitignored — populated by `npm -w web run build`)
  bin/         super-admin bootstrap CLI
web/           EMAILER frontend — Vite + React UI source  → deploys as `aiployee-emailer`
api/           Vercel function entrypoint (wraps Fastify as serverless handler)
apps/
  command-centre/   COMMAND CENTRE frontend (cc-web) + its own Vercel function entrypoint
                    → deploys as `aiployee-command-centre`. See apps/command-centre/README.md
vercel.json    Vercel config — rewrites all /api, /auth, /v1, /healthz to api/index
docker/        Optional VPS deployment (Dockerfile + Caddy) — secondary path
docs/
  superpowers/
    specs/     Design specs
    plans/     Implementation plans (incl. 2026-06-08 segmentation / monorepo split)
    DEPLOY-segmentation.md   two-Vercel-project deploy runbook
  acceptance/  Acceptance walkthrough
```

### Cross-app SSO & the Command Centre

The Emailer and the Command Centre are **two Vercel projects on two `*.vercel.app` origins running the identical Fastify backend against the same Supabase database**. Because they can't share a cookie across origins, moving between them uses a handoff token:

- A logged-in user hits `GET /auth/handoff?to=<other app>` (the "Command Centre →" / "Email →" sidebar links).
- The backend mints a **60-second, single-use HMAC token** (`packages/core/src/routes/handoff.ts`), the receiving app verifies it and mints its own session.
- This works **only because both Vercel projects share `SESSION_SECRET` and the `users` table.** If the Command Centre's `SESSION_SECRET` doesn't match this app's, handoff tokens fail to verify. `EMAILER_ENC_KEY`, `DATABASE_URL`, and `CRON_SECRET` must match too; only `PUBLIC_BASE_URL` legitimately differs per origin.

Setting up or deploying the Command Centre project? See **[`apps/command-centre/README.md`](apps/command-centre/README.md)**.

## Deployment

### Production (Vercel) — current setup

```bash
# 1. Install Vercel CLI once
npm i -g vercel

# 2. Link
vercel link --yes --project aiployee-emailer

# 3. Point DATABASE_URL at Supabase — use the TRANSACTION POOLER (Supavisor)
#    connection string (port 6543), NOT the direct 5432 URL. The app pins
#    Supabase's Root 2021 CA, so no sslmode/sslrootcert params are needed.
vercel env add DATABASE_URL production   # paste the Supavisor pooler URI

# 4. Set the four other env vars in the Vercel dashboard or via CLI
#    (https://vercel.com/<org>/aiployee-emailer/settings/environment-variables)
#
#    SESSION_SECRET   — `openssl rand -base64 48`
#    EMAILER_ENC_KEY  — `openssl rand -base64 32`   ← if lost, all stored SMTP passwords are unrecoverable
#    PUBLIC_BASE_URL  — https://aiployee-emailer.vercel.app
#    CRON_SECRET      — `openssl rand -base64 24`   ← shared with cron-job.org

# 5. Deploy
vercel deploy --prod --yes

# 6. Run migrations against the live Supabase DB
vercel env pull .env.production --environment=production --yes
DBURL=$(grep '^DATABASE_URL=' .env.production | sed 's/^DATABASE_URL=//' | tr -d '"')
DATABASE_URL="$DBURL" npx -w server node-pg-migrate -m migrations up

# 7. Bootstrap the first super-admin
DATABASE_URL="$DBURL" \
SESSION_SECRET="<paste>" EMAILER_ENC_KEY="<paste>" \
PUBLIC_BASE_URL=https://aiployee-emailer.vercel.app CRON_SECRET="<paste>" \
node server/dist/bin/createAdmin.js root@aiployee.co.za 'pick-a-strong-password'
```

### Wire cron-job.org

Sign up at https://cron-job.org, then create **two** jobs:

| Title | URL | Method | Schedule | Header |
|---|---|---|---|---|
| AIployee Emailer — process queue | `https://aiployee-emailer.vercel.app/v1/cron/process-queue` | POST | every 1 min | `Authorization: Bearer <CRON_SECRET>` |
| AIployee Emailer — retry failed | `https://aiployee-emailer.vercel.app/v1/cron/retry-failed` | POST | every 1 min | `Authorization: Bearer <CRON_SECRET>` |
| AIployee Emailer — analyze replies | `https://aiployee-emailer.vercel.app/v1/cron/analyze-replies` | POST | every 15 min | `Authorization: Bearer <CRON_SECRET>` |

Both should return `200 {"ok":true,...}` when "Run now" is hit.

### Local development

```bash
# Postgres
docker compose -f docker/docker-compose.dev.yml up -d

# Install + migrate + run
npm install
DATABASE_URL=postgres://emailer:emailer@localhost:5433/emailer \
  npx -w server node-pg-migrate -m migrations up
cp docker/.env.example .env
npm -w server run dev
npm -w web run dev   # in a second terminal
```

### Optional VPS path

A Hetzner CX11 + `docker compose up -d --build` setup is included in `docker/`. Same code, same DB schema — useful if Vercel/Supabase ever stop fitting. Not the primary path.

## Wiring an automation platform (e.g. Jobix)

The AIployee Emailer is **just an HTTP endpoint** — no special "integration" registration is needed on the workflow platform's side. From any Jobix workflow:

1. **Generate an API key.** Sign in to https://aiployee-emailer.vercel.app as the tenant admin → API Keys → Generate. Copy the `aip_live_…` value (only shown once).
2. **Add a webhook / HTTP step** in your workflow editor (the same node type you use for any outbound webhook):
   - **Method:** POST
   - **URL:** `https://aiployee-emailer.vercel.app/v1/emails`
   - **Headers:**
     - `Authorization: Bearer aip_live_…`
     - `Content-Type: application/json`
   - **Body:**
     ```json
     {
       "from": "alex@aiployee.co.za",
       "to": "{{customer.email}}",
       "subject": "Your call summary",
       "html": "<p>{{call.summary}}</p>"
     }
     ```
     Or use a stored template:
     ```json
     {
       "from": "alex@aiployee.co.za",
       "to": "{{customer.email}}",
       "template": "call_summary",
       "variables": { "name": "{{customer.full_name}}", "summary": "{{call.summary}}" }
     }
     ```
3. **Branch on the response.** The endpoint returns `{ id, status, message_id, error }` synchronously for immediate sends. Status is `"sent"` or `"failed"` (or `"queued"` if you supplied `scheduled_for`).

The `from` address must match a sender registered in the app's UI for that tenant, otherwise you get `invalid_sender`.

## Onboarding a client (5 minutes)

1. Sign in at https://aiployee-emailer.vercel.app as super-admin.
2. **Tenants → Add** → name, slug, client admin email → click Create. UI returns an invite URL.
3. Email the invite URL to the client.
4. Client clicks the link, sets their password, signs in.
5. Client adds their SMTP config (their own SES / Mailgun / Brevo creds) → adds a sender → generates an API key.
6. AIployee plugs the API key into the workflow that needs to send email. Done.

## API quick reference

```
Authorization: Bearer aip_live_…    (per-tenant API key)

POST /v1/emails
  { from, to, cc?, bcc?, reply_to?, subject?, html?, text?,
    template?, variables?, attachments?, scheduled_for? }
  → 202 { id, status, scheduled_for?, message_id?, error? }

GET  /v1/emails/:id                        → email row with current status
GET  /v1/emails?status=&since=&limit=      → tenant-scoped list

POST /v1/jobix/calls                       (per-tenant API key — structured call ingest)
  { company_key?, customer_data?: { main, values }, ... }  (any Jobix post-call shape)
  → 202 { created, message_id }

POST /v1/webhooks/bounce/ses               (SES SNS, signature-verified)
POST /v1/webhooks/bounce/mailgun           (Mailgun, HMAC-verified)

GET  /v1/unsubscribe/:token                (public — one-click campaign unsubscribe)
POST /v1/unsubscribe/:token                (public — confirm unsubscribe)

POST /v1/cron/process-queue                (cron-job.org, Bearer CRON_SECRET)
POST /v1/cron/retry-failed                 (cron-job.org, Bearer CRON_SECRET)
POST /v1/cron/analyze-replies              (cron-job.org, Bearer CRON_SECRET — campaign reply analysis)
```

## Status

**Live in production** at https://aiployee-emailer.vercel.app (Vercel + Supabase Postgres, 40+ migrations applied). The transactional emailer, the multi-tenant admin UI, Abe (the call-line analyst with human-approval send-gate), structured call ingest (`/v1/jobix/calls`), and the Call Analytics Center are all deployed.

The server test suite is a large DB-backed integration suite (run serially against a Neon test branch); the strict `tsc` build gates every deploy. New work follows a spec → plan → TDD flow under `docs/superpowers/`.

Per-feature design specs, implementation plans, and the original acceptance walkthrough live under `docs/`. The acceptance walkthrough at `docs/acceptance/README.md` remains the manual gate for the core email path before onboarding a new client to live traffic.

## License

Proprietary — internal AIployee tool. Not for external distribution.
