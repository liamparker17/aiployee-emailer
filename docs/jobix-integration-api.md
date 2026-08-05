# Aiployee Emailer — API Documentation for Jobix Integration

This document is for the Jobix-side AI/engineer setting up the integration. It covers everything Jobix needs to call the Aiployee emailer and receive results back.

**Base URL:** `https://aiployee-emailer.vercel.app`

---

## Authentication

Every request must carry the tenant's API key. All three header forms are accepted:

```
api_key: aip_live_xxx          (Jobix's usual convention)
X-Api-Key: aip_live_xxx
Authorization: Bearer aip_live_xxx
```

The key identifies the tenant — never send a tenant id. Master keys and sub-keys both work. Missing/invalid key → `401`.

**Error format (all endpoints):**
```json
{ "error": { "code": "bad_request", "message": "human-readable detail" } }
```

---

## 1. POST /v1/agent/messages — talk to the agent

Post a message into a conversation thread; the emailer's agent runs one turn (LLM + optional tools/RAG configured tenant-side) and may act (e.g. send an email).

```
POST /v1/agent/messages
api_key: aip_live_xxx
Content-Type: application/json
```
```json
{
  "thread_ref": "jobix-thread-123",
  "message": "Draft a reply confirming the customer's policy renewal.",
  "subject": "Policy renewal — Jane Doe",
  "context": { "policy_number": "P-4471", "customer_name": "Jane Doe" },
  "message_ref": "jobix-msg-987"
}
```

| Field | Required | Meaning |
|---|---|---|
| `thread_ref` | yes | **Jobix's** stable conversation id. Same value = same thread (agent keeps history for context). New value = new thread. |
| `message` | yes | The instruction/content for this turn. |
| `subject` | no | Thread subject (used when the thread is first created). |
| `context` | no | Arbitrary JSON object; appended to the message for the agent to use. |
| `message_ref` | no | Idempotency key. A retried `message_ref` returns the original result with `"duplicate": true` — safe to retry on network errors. |

**Response `202`** (the agent turn runs inside the request, so the outcome is included):
```json
{
  "thread_ref": "jobix-thread-123",
  "message_id": "9f2c…",
  "status": "sent",
  "response_text": "Hi Jane, your policy P-4471 has been renewed…"
}
```

- `status: "sent"` — the agent's response was auto-approved and acted on (Jobix-sourced messages are auto-approved by default).
- `status: "drafted"` — the tenant has auto-approve turned off; the response awaits human approval. The final outcome arrives via the webhook (section 2).
- `400 agent_disabled` — the tenant hasn't enabled the agent in the Aiployee UI.

The same outcome is also delivered to the tenant's configured webhook (below), so handle either the synchronous response or the webhook — webhooks are the reliable path since drafted messages resolve later.

## 2. Webhook: Emailer → Jobix (`agent.response`)

The tenant configures a Jobix webhook URL + secret in the Aiployee UI (AI responses tab). The emailer POSTs whenever an agent result is finalized, and again if a draft is later approved/rejected.

```
POST <your webhook URL>
Content-Type: application/json
X-Aiployee-Signature: sha256=<hex HMAC-SHA256 of raw body, keyed with the webhook secret>
```
```json
{
  "event": "agent.response",
  "thread_ref": "jobix-thread-123",
  "message_id": "9f2c…",
  "status": "sent",
  "response_text": "Hi Jane, your policy P-4471 has been renewed…",
  "actions": [],
  "ts": "2026-08-03T10:15:00Z"
}
```

| `status` | Meaning |
|---|---|
| `sent` | Response finalized and any action carried out. |
| `drafted` | Awaiting human approval — a later webhook fires with `sent` or `rejected`. |
| `rejected` | A human rejected the draft; nothing was sent. |

**Verify the signature:** compute `sha256=` + hex HMAC-SHA256 of the **raw request body** using the shared secret; compare to `X-Aiployee-Signature` and reject mismatches. Make the handler idempotent on (`thread_ref`, `message_id`, `status`) — you may see `drafted` then `sent`, plus retries.

## 3. POST /v1/emails — direct transactional send (no agent)

For plain sends where Jobix already knows exactly what to email.

```
POST /v1/emails
api_key: aip_live_xxx
Content-Type: application/json
```
```json
{
  "from": "support@yourdomain.com",
  "to": "jane@example.com",
  "template": "policy_renewal",
  "variables": { "customer_name": "Jane Doe", "policy_number": "P-4471" }
}
```

| Field | Required | Notes |
|---|---|---|
| `from` | yes | Must be a sender configured on the tenant. |
| `to` | yes | Single email address. |
| `cc`, `bcc` | no | Arrays of email addresses. |
| `reply_to` | no | Email address. |
| `subject` + `html` | either this pair… | Raw content send. `text` optional plain-text part. |
| `template` | …or this | Template name configured on the tenant. Templates support `{{var}}` and `{{#if var}}…{{/if}}`. |
| `subject` (with `template`) | no | If the template's subject is left **blank** in Aiployee, the `subject` you send here is used instead. A non-blank template subject always wins. |
| `variables` | no | Map of template variables. Values may be string, number, boolean, or null (coerced to strings) — LLM-native JSON is fine. |
| `attachments` | no | `[{ "filename": "...", "content": "<base64>", "content_type": "application/pdf" }]` |
| `scheduled_for` | no | ISO datetime; queues instead of sending now. |

**Response `202`.** Immediate sends are dispatched inline, so you get the real result:
```json
{ "id": "e-uuid", "status": "sent", "message_id": "<provider id>", "error": null }
```
`status` can be `sent`, `failed` (with `error`), `queued`, or `scheduled`. Check later with:

```
GET /v1/emails/:id        → full status of one email
GET /v1/emails            → recent emails for the tenant
```

## 4. POST /v1/jobix/calls — push call results into Aiployee

After a Jobix call completes, POST the call payload here so Aiployee's call analytics/agent pipeline ingests it. The body is intentionally lenient — send your natural call JSON.

```
POST /v1/jobix/calls
api_key: aip_live_xxx
Content-Type: application/json
```

Requirements on the payload (max 256 KB):
- It must contain **either** an explicit call id (`call_id`, `call_ref`, or `id`) **or** a `suid` (top level, or at `customer_data.main.suid`) — ideally with a `timestamp`/`call_time`/`created_at`. This becomes the idempotency reference: re-sending the same call is deduped.
- `company_key` (optional) attributes the call to a specific line.
- `call_outcome` or `outcome` (optional) — if a `suid` is present, the outcome is also linked back to any outbound call-campaign row with that suid.

**Response `202`:**
```json
{ "created": true, "message_id": "m-uuid" }
```
`created: false` means the call was already ingested (duplicate ref) — safe to retry.

---

## Integration rules of thumb

1. **One `thread_ref` per conversation** — reuse it every turn so the agent has history.
2. **Always send `message_ref`** on `/v1/agent/messages` and retry safely on timeouts.
3. **Trust the webhook, not just the 202**, for final outcomes (drafts resolve later).
4. **Verify webhook signatures** and process events idempotently.
5. **Send call results to `/v1/jobix/calls`** with a stable `suid`/call id so dedupe and campaign outcome-linking work.
