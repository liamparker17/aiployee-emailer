# Marketing Suite Design (Brevo-style)

**Date:** 2026-05-29
**Status:** Draft for review — large, multi-phase. Each phase gets its own plan before build.

## Goal

Add a marketing layer on top of the transactional/agentic emailer: **contacts & lists**,
**segmentation**, and **bulk campaigns** with engagement analytics and compliant
unsubscribe — without disturbing the existing transactional + Jobix-agent product.

## Locked decisions (2026-05-29)

1. **Contacts:** standard fields (email, name) + arbitrary **custom attributes (jsonb)**; **CSV import/export**.
2. **Audiences:** **static lists** (manual membership) **and dynamic segments** (rule-based, live).
3. **Bulk sending:** reuse the tenant's existing **SMTP**, **drip through the cron queue**, and **warn** when an audience exceeds the provider's likely daily cap (e.g. Gmail ~500/day). No new sending infra in v1.
4. **Compliance (always-on):** every campaign email gets an unsubscribe link + `List-Unsubscribe` header; unsubscribing flips the contact and adds a suppression. Campaigns skip unsubscribed/suppressed contacts. (CAN-SPAM / POPIA.)

## Data model (new tables, all tenant-scoped, `tenant_id` FK ON DELETE CASCADE)

- **`contacts`** — `id`, `tenant_id`, `email`, `name`, `attributes jsonb` (default `{}`),
  `subscribed boolean` (default true), `unsubscribed_at`, `created_at`. Unique `(tenant_id, email)`.
- **`contact_lists`** — `id`, `tenant_id`, `name`, `created_at`.
- **`contact_list_members`** — `list_id` FK, `contact_id` FK, `added_at`; PK `(list_id, contact_id)`.
- **`segments`** — `id`, `tenant_id`, `name`, `filter jsonb` (rule tree), `created_at`.
- **`campaigns`** — `id`, `tenant_id`, `name`, `sender_id` FK, `template_id` FK (or inline
  `subject`/`body_html`), `audience_type ('list'|'segment')`, `audience_id`,
  `scheduled_for`, `status ('draft'|'scheduled'|'sending'|'sent'|'canceled')`, `created_at`.
- **`emails.campaign_id`** (new nullable column, FK `campaigns(id)` ON DELETE SET NULL) — links
  each sent email back to its campaign so per-campaign analytics reuse `email_events`.

## Segmentation

`filter` is a small JSON rule tree: `{ op: 'and'|'or', rules: [{ field, cmp, value }] }`.
- `field`: a standard column (`email`, `subscribed`) or `attributes.<key>`.
- `cmp`: `eq`/`neq`/`contains`/`exists`/`gt`/`lt`.
- Compiled to a parameterized SQL `WHERE` over `contacts` (attributes via `attributes->>'key'`).
- **Engagement segments** (e.g. "opened campaign X") are a Phase-B stretch: join `email_events`
  through `emails.campaign_id`. v1 starts with attribute + subscribed filters.
- Dynamic segments evaluate live at campaign-send and preview time (count + sample).

## Campaign send pipeline (reuses existing infra)

1. Resolve audience → contact set; **exclude** `subscribed = false` and addresses in `suppressions`.
2. If count > provider cap heuristic → **warn** in the UI before confirming.
3. On send: create one **queued `emails`** row per recipient (rendered from the template +
   contact attributes as variables), tagged with `campaign_id`, `scheduled_for` = now or schedule.
4. The existing **cron** (`/v1/cron/process-queue`, `cronBatchSize`) drips them out — natural throttle.
5. Open/click tracking already injects per-email; per-campaign stats = aggregate `email_events`
   over that `campaign_id` (reuse `engagementSummary` shape).
6. Unsubscribe link `{baseUrl}/v1/unsubscribe/:contactToken?c=:campaignId` (auth-exempt, like `/v1/track`).

## API (sketch)

- Contacts: `GET/POST/PATCH/DELETE /api/contacts`, `POST /api/contacts/import` (CSV).
- Lists: `GET/POST/DELETE /api/lists`, `POST /api/lists/:id/members`, member add/remove.
- Segments: `GET/POST/DELETE /api/segments`, `GET /api/segments/:id/preview` (count + sample).
- Campaigns: `GET/POST /api/campaigns`, `POST /api/campaigns/:id/send`, `/cancel`,
  `GET /api/campaigns/:id` (with stats).
- Public: `GET /v1/unsubscribe/:token` (page + one-click), `POST` for List-Unsubscribe-Post.

## UI — a new "Marketing" sidebar section (keeps IA clean)

New grouped section with its own pages: **Contacts**, **Lists**, **Segments**, **Campaigns**
(compose wizard: audience → content → review/throttle-warning → schedule/send; plus a campaign
report view with opens/clicks/bounces/unsubs).

## Phasing (each phase = own plan, shipped + tested independently)

- **Phase A — Contacts & lists:** tables, CRUD, CSV import/export, list membership, UI. (foundation)
- **Phase B — Segments:** filter model + compiler + preview; dynamic segment as a campaign audience.
- **Phase C — Campaigns + compliance:** campaign model, send pipeline (audience→queued emails via
  cron, suppression/unsub exclusion), unsubscribe endpoint + List-Unsubscribe header, per-campaign
  report. `emails.campaign_id` migration here.

## Security / safety

Tenant-scoping on every query; CSV import size/row caps + email validation; unsubscribe token is
opaque/unguessable (HMAC or random); campaigns can only target the tenant's own lists/segments;
respect suppressions (no re-mailing bounced/complained/unsubscribed). Run `security-review` before
shipping Phase C (bulk send + public unsubscribe).

## Out of scope (v1)

A/B testing, landing pages, forms, drip automations/journeys, SMS/WhatsApp, dedicated bulk ESP
(covered by the throttle/warn approach for now).
