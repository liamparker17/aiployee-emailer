# Aiployee Agent ↔ Jobix Integration Contract

> **Status: TARGET DESIGN (Phase 1, not yet live).** This document defines the
> exact contract Jobix integrates against once the agent ships. Endpoints below do
> not exist yet. The existing live endpoint is `POST /v1/emails` (see the API Keys
> page guide). This doc removes ambiguity about how the agent will behave.

## Mental model (read this first)

The Aiployee emailer is an **agentic node in your Jobix swarm**. It does **not**
receive real inbound email. Instead:

1. **Jobix drives the conversation.** Jobix POSTs a message into a *thread* on the
   emailer.
2. **The emailer's agent runs** (OpenAI + optional MCP tools + optional RAG over the
   tenant's database) and produces a response/action (e.g. send an email).
3. **The emailer calls back to Jobix** via a webhook to update Jobix's agent on what
   happened in that thread.

So the loop is: **Jobix → emailer agent → (action) → webhook → Jobix.** A "thread"
is one conversation, identified by an id **you (Jobix) own and supply**.

## Authentication

Same as `/v1/emails`: send the tenant's API key in the `api_key` header (or
`X-Api-Key`, or `Authorization: Bearer`). Master keys and sub-keys both work and
both authenticate as the tenant. The key identifies the tenant; you never send a
tenant id.

## 1. Jobix → Emailer: post a message to the agent

```
POST /v1/agent/messages
api_key: aip_live_xxx
Content-Type: application/json
```
```json
{
  "thread_ref": "jobix-thread-123",
  "message": "Draft a reply to the customer confirming their policy renewal.",
  "context": { "policy_number": "P-4471", "customer_name": "Jane Doe" },
  "send": {
    "from": "support@yourdomain.com",
    "to": "jane@example.com",
    "template": "policy_renewal"
  },
  "message_ref": "jobix-msg-987"
}
```

| Field | Required | Meaning |
|-------|----------|---------|
| `thread_ref` | yes | **Your** stable id for the conversation. Same value = same thread (history is kept for agent context). New value = new thread. |
| `message` | yes | The instruction/content for the agent for this turn. |
| `context` | no | Structured data the agent may use (and feed to templates/tools). |
| `send` | no | If present, the agent may send an email as part of acting (uses the same fields as `/v1/emails`: `from`, `to`, `template`+`variables` or `subject`+`html`). |
| `message_ref` | no | Idempotency key — retries with the same `message_ref` are deduped. |

**Response — always async (HTTP 202):**
```json
{ "thread_ref": "jobix-thread-123", "message_id": "9f2c…", "status": "accepted" }
```
The agent runs in the background (it may call tools, which takes time). **You get the
result via the webhook, not this response.** `status` here is only `accepted` (queued)
or an error.

## 2. Approval: who can act without a human

- **Messages from Jobix are auto-approved.** Because the request is authenticated
  with the tenant's API key over this endpoint, it is a *trusted swarm source*, so
  the agent's response is acted on immediately (e.g. the email is sent) — no human in
  the loop.
- **Messages created manually in the Aiployee UI are NOT auto-approved** — they wait
  for a human to approve in the "AI responses" tab. (This path doesn't involve Jobix;
  it's mentioned so the behavior is unambiguous.)

This is configurable per tenant (`auto_approve_jobix`, default on). If turned off,
even Jobix-sourced responses wait for human approval — and the webhook will report
`status: "drafted"` until approved.

## 3. Emailer → Jobix: the callback webhook

Configure a **Jobix webhook URL** per tenant in the AI responses tab. The emailer
POSTs to it whenever an agent result is ready (and again if a draft is later
approved/sent). This is **how Jobix's agent learns the outcome on the thread.**

```
POST <your Jobix webhook URL>
X-Aiployee-Signature: sha256=<hmac of body with the tenant's webhook secret>
Content-Type: application/json
```
```json
{
  "event": "agent.response",
  "thread_ref": "jobix-thread-123",
  "message_id": "9f2c…",
  "status": "sent",
  "response_text": "Hi Jane, your policy P-4471 has been renewed…",
  "actions": [ { "type": "email_sent", "to": "jane@example.com", "email_id": "a1b2…" } ],
  "ts": "2026-05-29T10:15:00Z"
}
```

| `status` | Meaning for Jobix |
|----------|-------------------|
| `sent` | Agent responded and the action (e.g. email) was carried out. |
| `drafted` | Agent produced a response that is **waiting for human approval** (only when auto-approve is off / non-Jobix source). A second webhook fires later with `sent` or `rejected`. |
| `rejected` | A human rejected the draft; nothing was sent. |
| `error` | The run failed; `error` field explains why. No action taken. |

**Verify the signature:** HMAC-SHA256 of the raw body using the tenant's webhook
secret (shown once when you set the webhook URL). Reject mismatches.

## 4. Tools (MCP) and RAG — transparent to Jobix

The agent may use **MCP tools** and **RAG** (a live SQL query over a connected
database and/or semantic vector retrieval). **Jobix does not configure or see these**
— the tenant sets them up in the AI responses tab. They only change the *quality* of
the agent's response; the contract above is unchanged.

## 5. End-to-end sequence

```
Jobix ──(1) POST /v1/agent/messages (api_key)──▶ Emailer
Emailer ──202 {status:"accepted", message_id}──▶ Jobix
Emailer: run agent (OpenAI + MCP + RAG); source=Jobix ⇒ auto-approve ⇒ act (send email)
Emailer ──(3) POST webhook {event:"agent.response", status:"sent", actions:[…]}──▶ Jobix
Jobix: update its agent on the thread using thread_ref
```

## 6. Rules of thumb for integrators

- **One `thread_ref` per conversation.** Reuse it for every turn so the agent has history.
- **Don't wait on the 202 for the answer** — handle the webhook.
- **Make your webhook idempotent** (you may receive `drafted` then `sent`, and retries).
- **Send the API key in `api_key`** (Jobix's default header), exactly like `/v1/emails`.
- **`send` is optional** — omit it if you only want the agent to reason/respond and
  report back without emailing.

## Open contract questions (to finalize before Phase 1 build)

- Exact `actions` taxonomy beyond `email_sent` (e.g. `tool_called`, `no_action`).
- Whether Jobix wants a synchronous mini-result in the 202 for fast/no-tool runs.
- Webhook retry/backoff policy and event types (`agent.response` only, or also
  `thread.created`, `approval.pending`).
