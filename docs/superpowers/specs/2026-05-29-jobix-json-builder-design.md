# Jobix JSON Builder Design

**Date:** 2026-05-29
**Status:** Approved
**Scope:** Frontend only (`web/`). No backend/API/DB changes.

## Goal

A dedicated page where the user builds an email flow and gets the two JSON blocks
to paste into Jobix: the **LLM node output schema** and the **Web-call API node
payload** (with `{{ <node>.field }}` anchors), plus the static node config (URL,
method, headers). Generated client-side from existing template/sender data.

## Decisions (locked)

1. **Input source:** start from an existing saved template (auto-derive its
   `{{variables}}`); allow adding extra ad-hoc fields.
2. **Placement:** dedicated sidebar page, route `/t/:tenantId/jobix-builder`.
3. **Recipient:** chosen per build — "LLM-extracted" (adds `recipient_email` to the
   schema; `to = {{ <node>.recipient_email }}`) or "fixed address" (`to` = a typed
   literal email).
4. **v1 scope:** one email per build. Multi-email flows = run it per Web-call node
   (the dual-node pattern stays documented in the API-keys guide).

## Contract (verified against `server/src/send/pipeline.ts` SendInputShape)

`POST /v1/emails` accepts `{ from, to, template, variables: Record<string,string> }`
(or subject+html; the builder targets the template path). Anchors must sit inside
quoted JSON strings (Jobix strict-JSON), which `JSON.stringify` guarantees.

## Page (`web/src/pages/JobixBuilder.tsx`)

**Data:** on mount, `GET /api/templates` (→ `{ name, variables: string[] }`) and
`GET /api/senders` (→ `{ email, display_name, is_default }`).

**Controls:**
- Template select (required). Empty → `EmptyState` linking to Templates.
- From-sender select (defaults to the default sender; falls back to first).
- Recipient mode toggle: LLM-extracted | fixed; fixed shows an email input.
- Node reference input (default `llm_node_X`) — the Jobix node id/name the anchors
  reference; a hint explains replacing it with the real node id (e.g. `llm_node_21`).
- Optional "extra fields" list (comma/word entry) appended to the schema + payload.

**Derived fields:** `fields = template.variables ∪ extraFields` (deduped);
plus `recipient_email` in the schema when recipient mode = LLM.

**Outputs (three copy blocks):**
1. **LLM node — Output JSON schema:** `{ [field]: "string", ... }` (+ `recipient_email`
   if LLM mode). `JSON.stringify(obj, null, 2)`.
2. **Web-call API node — Payload:**
   ```json
   { "from": "<sender>", "to": "<fixed | {{ node.recipient_email }}>",
     "template": "<name>", "variables": { "<field>": "{{ node.<field> }}", ... } }
   ```
3. **Web-call node config:** method `POST`, URL `${origin}/v1/emails`,
   headers `Content-Type: application/json` and `api_key: <your API key>` (note to
   paste a real key from the API Keys page).

Reuse brand components (`PageHeader`, `Card`, `Field`, `Input`, `Button`,
`EmptyState`). Extract a shared `CopyButton` (`web/src/components/CopyButton.tsx`)
for the code blocks (toast on copy).

## Wiring

- `routes.tsx`: add child route `{ path: 'jobix-builder', element: <JobixBuilder /> }`
  under `/t/:tenantId`.
- `AppShell.tsx`: add a nav link (lucide `Wand2` or `Braces` icon) to
  `${base}/jobix-builder`.

## Testing

No web unit tests exist. Verify `cd web && npm run build` passes and manually
confirm the generated JSON is valid and anchors render inside quotes.

## Out of scope

- Backend changes; persisting builds; multi-email-in-one-build; editing templates
  from this page.
