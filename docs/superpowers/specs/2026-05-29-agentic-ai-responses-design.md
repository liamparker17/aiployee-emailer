# Agentic AI Responses Platform — Design (v1)

**Date:** 2026-05-29
**Status:** Draft for review — large, multi-phase. Each phase gets its own
spec + plan before implementation.

## Vision

Turn the emailer into an **agentic node in a Jobix swarm**: an OpenAI-backed agent
that processes message threads, composes responses (using MCP tools + RAG over a
tenant's database), and emits webhooks back to Jobix to keep its agent updated on
the thread.

## Locked decisions (2026-05-29)

1. **No real inbound email.** Threads/messages are **driven by Jobix** via our
   authenticated API — Jobix pushes content; we do not receive/parse real recipient
   email. (Removes the entire inbound-email/IMAP/ESP subsystem.)
2. **RAG = both** — a live SQL-query tool over a connected DB **and** embeddings +
   vector retrieval.
3. **MCP = first-class** — tenant-configured MCP servers exposed to the agent as tools.
4. **Approval model:** responses need **human approval by default**, **except
   content originating from Jobix, which is auto-approved** (Jobix = trusted source
   within the swarm; authenticated by tenant API key).

## Architecture

```
Jobix ──POST /v1/agent/messages (api_key)──▶ Emailer
                                              │ create/append thread
                                              │ run agent (OpenAI + tools)
                                              ├─ source=jobix → auto-approve → act (send / reply) ─▶ webhook back to Jobix
                                              └─ source=other → store pending_approval ─▶ "AI responses" tab → human approves ─▶ act + webhook
```

Agent run = build context (thread history + RAG retrieval) → OpenAI tool-calling
loop (MCP tools, RAG tools, send-email tool) → produce response → approve/act path.

## Data model (new tables, per-tenant, tenant_id FK ON DELETE CASCADE)

- **`agent_configs`** — `tenant_id` (unique), `enabled`, `model`, `system_prompt`,
  `openai_key_encrypted` (bytea, via existing `crypto/enc.ts`),
  `auto_approve_jobix` (bool, default true), `max_tool_iterations`, timestamps.
- **`agent_threads`** — `id`, `tenant_id`, `jobix_thread_ref` (external id; unique
  per tenant), `subject`, `status`, timestamps.
- **`agent_messages`** — `id`, `thread_id`, `tenant_id`, `role`
  (`inbound`|`agent`|`system`), `source` (`jobix`|`manual`), `content`,
  `status` (`pending_approval`|`approved`|`sent`|`rejected`), `approved_by`,
  `approved_at`, `created_at`.
- **`mcp_servers`** — `id`, `tenant_id`, `name`, `url`, `auth_encrypted`, `enabled`.
- **`rag_sources`** — `id`, `tenant_id`, `kind` (`sql`|`vector`),
  `connection_encrypted`, `config jsonb`, `enabled`.
- **`rag_documents`** (vector store) — `tenant_id`, `source_id`, `content`,
  `embedding vector(1536)`, `metadata jsonb`. Uses **pgvector on Neon** (Neon
  supports the `vector` extension — no separate vector DB needed).
- **`agent_audit`** — every agent action + tool call: `tenant_id`, `thread_id`,
  `action`, `tool`, `input_summary`, `output_summary`, `created_at`.

## Endpoints

- `POST /v1/agent/messages` (API-key auth) — Jobix ingests a message into a thread
  (by `jobix_thread_ref`); triggers an agent run; `source=jobix` ⇒ auto-approve.
- `GET /api/agent/threads`, `GET /api/agent/threads/:id` (session) — inbox + thread view.
- `POST /api/agent/messages/:id/approve` · `/reject` (session, admin) — human approval.
- `GET/PUT /api/agent/config`, CRUD `/api/agent/mcp-servers`, `/api/agent/rag-sources`
  (session, admin) — configuration.

## UI — "AI responses" tab (new sidebar page)

- **Config:** enable agent, model, system prompt, OpenAI key, auto-approve-Jobix toggle.
- **Connectors:** MCP servers (name/url/auth), RAG sources (SQL conn + vector ingest).
- **Inbox/threads:** conversations, pending-approval drafts with Approve/Edit/Reject,
  agent action/audit trail per thread.

## Safety layer (cross-cutting — designed in, not bolted on)

⚠️ Inbound message content is **untrusted** and the agent holds powerful tools
(send-email, SQL, MCP). Prompt-injection → data-exfiltration is the primary threat.

- Message content is **data, never instructions** — fenced in the prompt; system
  prompt hardened; tool use never elevated by message text.
- **Human approval is the backstop** for all non-Jobix content; auto-approve is
  strictly limited to authenticated Jobix-sourced messages.
- **Per-agent tool allowlist**; RAG SQL is read-only / scoped; MCP servers explicitly
  enabled per tenant.
- **Audit log** of every tool call + action; **cost controls** (max tokens/run, max
  tool iterations, per-tenant rate limit).
- Secrets (OpenAI key, MCP auth, DB conn) encrypted with the existing AES-GCM
  `crypto/enc.ts` (`EMAILER_ENC_KEY`).

## Infra / dependencies

- `openai` SDK; an MCP client (`@modelcontextprotocol/sdk`); pgvector migration on Neon.
- Vercel Fluid Compute (300s) covers a single agent run; long RAG **ingestion** runs
  async via **Vercel Queues / Workflow** (deferred to the RAG phase).

## Phased build (each phase = own spec + plan, shipped + verified independently)

1. **Foundation + agent core** — data model (`agent_configs`/`threads`/`messages`),
   `POST /v1/agent/messages`, OpenAI responder (no external tools yet), approval
   workflow (Jobix auto-approve), AI-responses UI (config + inbox).
2. **Jobix outbound webhooks** — notify Jobix on thread/agent events (+ retries).
3. **MCP integration** — backend MCP client; tenant MCP servers as agent tools.
4. **RAG: live SQL tool** — connect a DB; read-only query tool for the agent.
5. **RAG: embeddings + pgvector** — ingestion + semantic retrieval tool.
6. **Safety/cost hardening + audit finalization.**

## Open questions for the next design pass

- OpenAI key: per-tenant (tenant brings their own) or one platform key billed centrally?
- Which model default (e.g. `gpt-4.1`/`gpt-4o`-class) and do we route via Vercel AI
  Gateway for observability/fallback?
- Exact Jobix webhook contract (payload shape Jobix expects to "update its agent").
- "Any database" connectors scope for v1 (Postgres only first, or also MySQL/others?).

## Out of scope (v1)

Real inbound email; multi-agent orchestration inside the emailer; fine-tuning;
non-email channels.
