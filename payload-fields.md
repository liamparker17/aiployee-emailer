# Payload Fields — `POST /v1/emails`

Quick reference for wiring the AIployee Emailer into a Jobix custom integration (or any
outbound webhook). This is the contract for **sending one email**.

> **Legend:** ✅ available today · 🔜 lands with the Jobix-hardening work (see the design
> spec in `docs/superpowers/specs/`). Until 🔜 items ship, use the "today" alternatives noted below.

---

## Endpoint

| | |
|---|---|
| **URL** | `https://<your-domain>/v1/emails` |
| **Method** | `POST` |
| **Auth** | per-tenant API key (`aip_live_…`), generated in the admin UI → API Keys |

## Headers

| Key | Value | Required | Notes |
|---|---|---|---|
| `Content-Type` | `application/json` | yes | |
| `api_key` | `aip_live_…` | yes | 🔜 raw key, no prefix — matches Jobix's header field. **Today:** use `Authorization: Bearer aip_live_…` instead. |
| `Idempotency-Key` | unique per workflow run | recommended | 🔜 a value Jobix guarantees unique per run (e.g. its execution/run ID). Makes retries safe — a re-fire returns the original result instead of sending twice. |

## Payload fields (JSON body)

| Field | Type | Required | Description |
|---|---|---|---|
| `from` | string (email) | yes\* | Must match a sender registered for the tenant. \*Omit if the API key is bound to a specific sender (🔜) — it's forced to that address. |
| `to` | string (email) | yes | Primary recipient. |
| `cc` | string[] (emails) | no | Carbon-copy recipients. |
| `bcc` | string[] (emails) | no | Blind carbon-copy recipients. |
| `reply_to` | string (email) | no | Overrides the sender's default reply-to. |
| `subject` | string | conditional | Required unless `template` is used. |
| `html` | string | conditional | HTML body. Required unless `template` is used. |
| `text` | string | no | Plain-text alternative part. |
| `template` | string | conditional | Name of a stored template. Use **instead of** `subject`+`html`. |
| `variables` | object (string→string) | no | Values for `{{placeholders}}` in the template. |
| `attachments` | object[] | no | Each: `{ "filename": string, "content": <base64>, "content_type"?: string }`. |
| `scheduled_for` | string (ISO 8601) | no | Future send time. Omit (or past time) = send immediately. |

**Body rule:** provide **either** `subject` + `html` **or** `template`. A request with neither
fails with `validation_error`.

## Body examples

Inline HTML:
```json
{
  "from": "alex@acme.com",
  "to": "customer@example.com",
  "subject": "Your call summary",
  "html": "<p>Thanks for calling — here's your summary.</p>"
}
```

Stored template:
```json
{
  "from": "alex@acme.com",
  "to": "customer@example.com",
  "template": "call_summary",
  "variables": { "name": "Sam", "summary": "We booked your demo for Tuesday." }
}
```

Scheduled with an attachment:
```json
{
  "from": "alex@acme.com",
  "to": "customer@example.com",
  "subject": "Your invoice",
  "html": "<p>Invoice attached.</p>",
  "attachments": [
    { "filename": "invoice.pdf", "content": "JVBERi0xLjQK...", "content_type": "application/pdf" }
  ],
  "scheduled_for": "2026-06-01T09:00:00Z"
}
```

## Response

Immediate send → `202`:
```json
{ "id": "…", "status": "sent", "message_id": "…", "error": null }
```
- `status`: `sent` · `failed` · `queued` · `suppressed`.
  - `queued` = you supplied a future `scheduled_for`.
  - `suppressed` = recipient is on the tenant suppression list; nothing was sent. This is a
    normal `202` outcome, **not** an error — branch on it explicitly if you care.
- On `failed`, `error` holds the SMTP message; `message_id` is null.

Idempotent replay (🔜) → `200` with the **original** request's stored result (no second send).

## Error codes

Errors return `{ "error": { "code": "…", "message": "…" } }`.

| HTTP | `code` | Meaning |
|---|---|---|
| 401 | `unauthorized` | Missing or invalid API key. |
| 422 | `invalid_sender` | `from` is not a registered sender for this tenant (or violates a sender-bound key). |
| 422 | `validation_error` | Body failed validation (e.g. neither `subject`+`html` nor `template`, bad email). |
| 404 | `template_not_found` | Named `template` does not exist for this tenant. |

(A suppressed recipient is **not** an error — see the `suppressed` status above.)

> Note: pre-hardening, `invalid_sender` currently returns `400`. The `422` code above is the
> target contract finalized in the hardening work.
