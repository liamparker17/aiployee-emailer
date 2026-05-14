# AIployee Emailer — Acceptance Walkthrough (v1)

This document walks every spec acceptance criterion end-to-end against a freshly-built
deployment. Capture screenshots or curl transcripts in this directory as you go.

> Replace `email.aiployee.co.za` with your real `PUBLIC_HOST`, and replace
> `<KEY>` placeholders with the API key plaintext shown once at generation time.

---

## 0. Bring the stack up cleanly

```bash
cd docker
cp .env.example .env

# Fill the required secrets:
#   POSTGRES_PASSWORD   = strong random
#   SESSION_SECRET      = $(openssl rand -base64 32)
#   EMAILER_ENC_KEY     = $(openssl rand -base64 32)
#   PUBLIC_HOST         = email.aiployee.co.za
#   PUBLIC_BASE_URL     = https://email.aiployee.co.za
#   MAILGUN_SIGNING_KEY = (optional, for Mailgun webhooks)

docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml ps        # all services healthy

docker compose -f docker/docker-compose.yml exec app \
  node server/dist/bin/createAdmin.js root@aiployee.co.za 'super-pw-1!'
```

Expected: `postgres`, `app`, `caddy` all `healthy`. Caddy auto-issues a Let's Encrypt
cert for `PUBLIC_HOST` on first HTTPS request.

---

## AC #1 — Super-admin onboards a tenant

1. Browse to `https://email.aiployee.co.za/login`. Sign in as `root@aiployee.co.za`.
2. Sidebar shows **Tenants** (super-admin only). Click → **New tenant**.
3. Fill: name `Acme`, slug `acme`, admin email `admin@acme.com`. Submit.
4. Modal pops with the invite URL. Copy and open in an incognito window.
5. Set the new password (≥ 8 chars). You're redirected to `/login`.

**Pass:** Tenant created, invite URL displayed, accept-invite flow lands at the
login page and the new password works.

---

## AC #2 — Tenant admin configures SMTP, sender, template

Sign in as `admin@acme.com`.

1. **SMTP configs → Add.** Point `host`/`port`/`username`/`password` at a real
   provider (SES, Mailgun) or `smtp-tester` for local. Click **Test**, enter your
   own address, expect "Sent."
2. **Senders → Add sender.** `email = alex@acme.com`, display name `Alex`,
   reply-to optional, pick the SMTP config you just created. Save.
3. **Templates → New template.** Name `welcome`. Edit `subject = "Welcome, {{name}}"`,
   `body_html = "<p>Hi {{name}}, welcome to Acme.</p>"`. The variables panel
   auto-detects `name`; type a value to live-preview. Save.

**Pass:** SMTP test succeeds; sender + template are listed.

---

## AC #3 — Send via API

Generate a key: **API keys → Generate**, name `acme-prod`. Copy the plaintext
shown once.

```bash
curl -i -H "Authorization: Bearer <KEY>" \
     -H 'Content-Type: application/json' \
     -d '{
           "from":"alex@acme.com",
           "to":"liam@aiployee.co.za",
           "subject":"Hi",
           "html":"<p>hi</p>"
         }' \
     https://email.aiployee.co.za/v1/emails
```

Expected: `202 Accepted` with `{ "id": "...", "status": "queued"|"sent" }`.
Open **Email log** — the row appears and flips to `sent` within seconds.

---

## AC #4 — Scheduled send

```bash
SCHED=$(date -u -d '+90 seconds' +%FT%TZ)
curl -i -H "Authorization: Bearer <KEY>" \
     -H 'Content-Type: application/json' \
     -d "{
           \"from\":\"alex@acme.com\",
           \"to\":\"liam@aiployee.co.za\",
           \"subject\":\"Later\",
           \"html\":\"<p>later</p>\",
           \"scheduled_for\":\"$SCHED\"
         }" \
     https://email.aiployee.co.za/v1/emails
```

Expected: `202` with `status: "queued"`. Email log shows `queued`.
Wait ~2 minutes. The 30-second scheduler poller picks it up and dispatches —
status flips to `sent` within ~30s of the due time.

---

## AC #5 — Failed delivery surfaces SMTP error

1. **SMTP configs → Add** a deliberately-broken config (wrong password).
2. **Senders → Add** a sender bound to that config (different from-address).
3. Send via the API as in AC #3 using that broken sender.
4. After pg-boss exhausts retries, the email log row shows `failed` with the
   actual SMTP error string in the detail drawer.

**Pass:** `status = failed`, `error` populated with the SMTP server's response.

---

## AC #6 — Bounce webhook → suppression

Replay a real or synthetic SES SNS Notification JSON referencing a `message_id`
present in the email log:

```bash
curl -i -H 'Content-Type: application/json' \
     -d @docs/acceptance/fixtures/ses-bounce.json \
     https://email.aiployee.co.za/v1/webhooks/bounce/ses
```

Expected:
- The original email row flips to `bounced`.
- A new row appears in **Suppressions** for the recipient with `reason = bounce`.

(Mailgun equivalent: `POST /v1/webhooks/bounce/mailgun` with an HMAC-signed
form-encoded body — see `MAILGUN_SIGNING_KEY` in env.)

---

## AC #7 — Suppressed address is not sent to

Send via the API to the address suppressed in AC #6:

```bash
curl -i -H "Authorization: Bearer <KEY>" \
     -H 'Content-Type: application/json' \
     -d '{
           "from":"alex@acme.com",
           "to":"<suppressed@example.com>",
           "subject":"Should not send",
           "html":"<p>nope</p>"
         }' \
     https://email.aiployee.co.za/v1/emails
```

Expected: `202` with `status: "suppressed"`. SMTP server (or smtp-tester) records
no delivery attempt. Email log row is `suppressed`, no message-ID assigned.

---

## AC #8 — Tenant isolation

1. As super-admin, create a second tenant `Beta` with its own admin invite.
2. Accept the invite, sign in as Beta admin.
3. Confirm: **Senders, Templates, SMTP configs, API keys, Email log,
   Suppressions** are all empty for Beta — no Acme rows visible.
4. Take Acme's API key (still valid) and call:

   ```bash
   curl -i -H "Authorization: Bearer <ACME-KEY>" \
        -H 'Content-Type: application/json' \
        -d '{ "from":"someone@beta.com", "to":"x@example.com",
              "subject":"x", "html":"<p>x</p>" }' \
        https://email.aiployee.co.za/v1/emails
   ```

   Expected: `400` with `error.code = "invalid_sender"` — the API key is bound
   to Acme's tenant and `someone@beta.com` is not a sender it owns.

**Pass:** No cross-tenant reads, no cross-tenant sends.

---

## AC #9 — SMTP password is encrypted at rest

```bash
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U emailer -d emailer -c \
  "SELECT id, name, password_encrypted FROM smtp_configs LIMIT 1;"
```

Expected: `password_encrypted` column shows a binary blob (`\x...` hex), never
the plaintext password. AES-256-GCM ciphertext, key in `EMAILER_ENC_KEY`.

---

## AC #10 — Single-VPS docker-compose deploy

```bash
docker compose -f docker/docker-compose.yml ps
```

Expected: exactly **three** services running — `postgres`, `app`, `caddy`.
No external services, no managed dependencies. Total monthly cost on a Hetzner
CX11 ≈ $5.

---

## Sign-off

When every AC above passes:

```bash
git add docs/acceptance
git commit -m "docs: acceptance walkthrough artifacts for v1"
```

The v1 milestone is met.
