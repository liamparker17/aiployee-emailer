# Talk to Abe — Conversational Chat Interface — Design (v1)

**Date:** 2026-06-01
**Status:** Approved design — ready for implementation planning.
**Builds on:** Abe (re-engage employee, Plans A/B/C — shipped) and the existing tool-calling agent runner (`server/src/agent/runner.ts`, with MCP + RAG providers).

## Vision

Give the user a place to **actually talk to Abe** inside the app. Today Abe only communicates one-way (his work-log feed) and is managed via buttons/settings. This adds a conversational surface: you type, Abe responds using his real tools and knowledge — answering questions, advising, drafting copy, changing his own settings, and *proposing* work — while never being able to send email to contacts without the existing approval gate.

## Locked decisions (2026-06-01)

1. **Capability = blend ("C").** Abe can: **advise/read**, perform **safe writes** (his own settings, pause/resume, trigger a shift), and **propose** sends — but **risky sends are gated**: chat has no "send" tool, so anything that would email contacts can at most create a `pending_approval` play that routes to the existing approval flow.
2. **One persistent conversation per tenant** (a single ongoing thread). Multi/named threads deferred.
3. **Non-streaming** replies (send → "thinking…" → full reply). Token-streaming (SSE) deferred.
4. **Lives on Abe's home** as a "Talk to Abe" panel (not a separate route).
5. **Architecture = reuse `runner.ts`** (Approach 1): a new Abe tool provider + chat endpoint drive the existing tool-calling loop. No second agent core.
6. **Admin-only** (`tenant_admin`/`super_admin`), since chat can change settings + trigger shifts. Members still see Abe's home/feed.
7. **Abe's system prompt** (drafted this session) is the chat persona core, with the goal's `brand_voice` appended.

## Architecture & flow

```
User types ─▶ POST /api/agent/chat { message }
                │ load conversation history (agent_chat_messages)
                │ build messages: [system: ABE_SYSTEM + brand_voice, ...history, user]
                │ assemble tools: AbeToolProvider + existing MCP + RAG (compositeProvider)
                │ run runner.ts tool-calling loop (tenant OpenAI key + model from agent_configs)
                │   - tool calls execute (reads / safe-writes / propose); each logged to agent_audit
                │ persist user message + Abe's final reply
                ▼ return { reply }   (non-streaming)
```

- Uses the tenant's OpenAI key + model from `agent_configs` (same source as Abe's other work). If no key → the endpoint returns a friendly error and Abe's reply tells the user to connect one (mirrors the readiness story).
- Reuses the runner's existing per-run cap (`max_tool_iterations`) and adds a per-message token cap.

## Data model

New table **`agent_chat_messages`** (per-tenant, `tenant_id` FK ON DELETE CASCADE):
- `id` uuid pk, `tenant_id` uuid, `role` text check in (`'user'`,`'abe'`), `content` text, `created_at` timestamptz.
- Index on `(tenant_id, created_at)`.
- One conversation per tenant — no thread id in v1. Tool round-trips within a turn are **not** stored as chat rows (they're recomputed per turn); tool *invocations* are written to the existing `agent_audit`.

## The Abe tool provider

A new `McpToolProvider`-shaped provider (so it composes with MCP/RAG via the existing `compositeProvider`) exposing these LLM tools. Each tool is tenant-scoped.

**Read (always available):**
- `get_status` → goal enabled?, readiness (has OpenAI key, has default sender), paused/active.
- `count_dormant` → count from `findDormantContacts(window)`.
- `list_plays` → recent plays with status/size/created.
- `get_play_outcomes` → outcomes for a given (or latest) play.
- `get_settings` → current goal config (window, touches, spacing, brand voice, manager email + verified, auto-fire cap).

**Safe writes (execute, then confirm in the reply):**
- `update_settings` → `upsertGoal` with provided fields, **clamped to the server bounds** (dormant 1–3650, autofire ≥0, touches 1–5, spacing 1–60); email validated.
- `pause_abe` / `resume_abe` → set `enabled` false/true.
- `trigger_shift` → `runAbeShift` now. Per the tiered model this **proposes** a play (or auto-fires only if under the tenant's existing auto-fire cap — same as the cron). Chat itself never calls `startPlayExecution`.

**Gated:** none. There is intentionally **no `send`/`execute_play` tool**. The only path to contacts is the existing approval flow. A "send everyone" request therefore yields at most a `pending_approval` play; Abe's reply says "I've queued it for your sign-off."

(Drafting copy/subject lines requires no tool — the model writes it directly.)

## Endpoints

- `GET /api/agent/chat` (session, admin) → `{ messages: ChatMessage[] }` (the conversation, chronological).
- `POST /api/agent/chat` (session, admin) → body `{ message: string }` → runs the loop, persists, returns `{ reply: string }` (and optionally the updated messages).
- Both gated by an admin check (mirror `requireAdmin` in `routes/agent.ts`).

## UI — "Talk to Abe" panel (Abe's home)

- A chat panel on the Abe home page: scrollable message list (user right-aligned, Abe left-aligned in his first-person voice), an input + send button, and a "Abe is thinking…" indicator while awaiting the reply.
- Loads history via `GET /api/agent/chat` on mount.
- On send → `POST` → append Abe's reply. After a turn, refresh the home's readiness/feed/plays (reuse the existing `refresh` bump) so any settings change or new proposed play shows immediately.
- Admin-only (hidden/disabled for `tenant_user`).
- Empty state: a friendly first-message from Abe ("Hi — ask me how the win-backs are going, or tell me to adjust how I work.").

## Safety

- **Prompt-injection:** Abe's system prompt fences all contact data and tool outputs as *data, never instructions*. Even though the human chatting is trusted, tool outputs (contact content) are untrusted and must not redirect Abe.
- **No send capability** from chat — the structural guarantee that chat can't blast contacts.
- **Bounded writes:** `update_settings` clamps to the same server bounds the forms use.
- **Audit:** every tool call → `agent_audit` (tenant, tool, input/output summary).
- **Cost control:** reuse `max_tool_iterations`; add a per-message max-output-token cap.
- **No key:** if the tenant has no OpenAI key, the endpoint responds with guidance to connect one (no crash).

## Testing

- **Backend (Vitest + stub LLM, as existing agent tests):**
  - The stub returns a tool call then a final message; assert the loop runs, both messages persist, `GET` returns them.
  - `update_settings` tool actually changes the goal (and clamps an out-of-range value).
  - `trigger_shift` creates a play.
  - **Safety test:** a stub that "tries to send to everyone" results in at most a `pending_approval` play and **zero `emails` rows with status sent** — proving chat can't send.
  - Admin gate: non-admin → 403.
- **Frontend:** verified by `cd web && npm run build` (no test harness).

## Out of scope (v1)

Token streaming (SSE); multiple/named chat threads; a `send`/`execute_play` chat tool; voice; non-admin chat; cross-channel (WhatsApp etc.).

## Open questions for the build pass

- Exact `LlmClient` message-history shape the runner expects (assistant/tool roles) — confirm when wiring the chat loop into `runner.ts`.
- Whether `trigger_shift` from chat should pass a custom dormant window (one-off) or always use the saved goal — default: use the saved goal for v1.
