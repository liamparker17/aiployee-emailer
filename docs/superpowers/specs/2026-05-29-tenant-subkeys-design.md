# Tenant Sub-Keys Design

**Date:** 2026-05-29
**Status:** Approved
**Scope:** API-key model — backend (`server/`) + API-keys page (`web/`).

## Goal

Per tenant, allow a set of **sub-keys** hanging off the existing tenant ("master")
keys, so different Jobix flows can each use their own key for better tracking and
management. The existing tenant key keeps working exactly as today for the
integration build and the LLM node.

## Decisions (locked)

1. **Power:** Sub-keys are **labeled, full-access** — same full tenant authority as
   the master key. No scoping/permissions enforcement. They exist for attribution,
   rotation, and independent revocation.
2. **Structure:** **Parent link** — add nullable `parent_id` to `api_keys`.
   `parent_id IS NULL` ⇒ top-level/master key (every existing key, unchanged).
   `parent_id` set ⇒ sub-key of that master.
3. **Flow identity:** **Free-text label**, reusing the existing `name` field.
4. **Master revoke:** **Cascade** — revoking a master also revokes all its
   sub-keys. Revoking a sub-key affects only that sub-key.

## Data Model

`api_keys` gains:
- `parent_id uuid NULL REFERENCES api_keys(id) ON DELETE CASCADE`
- index on `parent_id`.

Invariants (enforced in app logic):
- One level deep: a sub-key's parent must have `parent_id IS NULL` (no sub-of-sub).
- Same tenant: parent must belong to the requesting tenant.
- Parent must not be revoked at creation time.

## Auth — UNCHANGED

The resolver in `server/src/auth/ctx.ts` stays
`UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 AND revoked_at IS NULL
RETURNING id, tenant_id`. Master and sub-keys both authenticate as the full tenant.
This preserves the current Jobix integration + LLM node behavior verbatim.

## Backend API

`server/src/repos/apiKeys.ts`:
- `ApiKeyRow` gains `parent_id: string | null`.
- `insertApiKey(pool, { tenantId, name, keyHash, keyPrefix, parentId? })` — inserts
  with optional `parent_id` (defaults NULL).
- `listApiKeys` — SELECT adds `parent_id`.
- `getApiKeyById(pool, tenantId, id)` — new; returns the row (incl. `parent_id`,
  `revoked_at`) or null, for parent validation.
- `revokeApiKey(pool, tenantId, id)` — when the target is a master, also set
  `revoked_at = now()` on its non-revoked children (cascade) in the same statement/
  transaction. Returns whether the target row was revoked.

`server/src/routes/apiKeys.ts`:
- `POST /api/api-keys` body becomes `{ name: string, parentId?: string (uuid) }`.
  If `parentId` provided: load it via `getApiKeyById` for the ctx tenant; 404 if not
  found; 400 (`invalid_parent`) if it is revoked or itself a sub-key
  (`parent_id != null`). Then insert with `parentId`.
- `GET /api/api-keys` — unchanged query path; response rows now include `parent_id`.
- `DELETE /api/api-keys/:id` — unchanged signature; cascade handled in repo.

## UI (`web/src/pages/ApiKeys.tsx`)

- `Key` interface gains `parent_id: string | null`.
- Group `items` into masters (`parent_id === null`) and their children. Render each
  master as a row; render its sub-keys as indented child rows beneath it (visual
  nesting, e.g. a left indent + "↳" / muted treatment).
- Each active master row gets an **"Add sub-key"** action opening the Generate modal
  in sub-key mode (passes `parentId`). The sub-key label uses the existing Name field.
- `Generate` component accepts an optional `parentId` and includes it in the POST body
  when present. Master generation path unchanged.
- Revoke per row unchanged (cascade is server-side). Plaintext one-time reveal +
  Jobix guide modal unchanged. **Jobix guide copy stays verbatim.**

## Testing

Server tests run on **Vitest, serially, against the Neon test branch**. Add to
`server/test/apiKeys.route.test.ts` (+ repo test if useful):
- create sub-key under a master → 201, row has `parent_id` = master id;
- list returns masters and sub-keys with `parent_id` populated;
- reject sub-of-sub (parent is itself a sub) → 400;
- reject parent from another tenant → 404;
- reject revoked parent → 400;
- revoking a master cascades: master + its sub-keys all `revoked_at` set;
- revoking a sub-key leaves the master and siblings active;
- (auth) a sub-key authenticates a `/v1/emails` call as the tenant just like a master.

Run `web` build to confirm UI compiles.

## Security

Touches the auth/key path → run `security-review` after implementation. Focus:
no cross-tenant parent linking, no privilege escalation (sub-keys can't create
deeper keys or escape tenant scope), cascade revoke leaves no orphaned live keys.

## Out of Scope

- Per-key scoping/permissions (sub-keys have full tenant access).
- Predefined flow taxonomy (labels are free text).
- Changing the auth resolution or the Jobix integration contract.
