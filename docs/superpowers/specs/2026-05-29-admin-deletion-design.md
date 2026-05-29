# Admin Deletion Design

**Date:** 2026-05-29
**Status:** Approved
**Scope:** Hard-delete capability for tenants, users, and API keys — backend (`server/`) + admin UI (`web/`).

## Goal

Give admins the ability to permanently delete data points that today can't be
removed: **tenants** (and all their data), **users**, and **API keys** (after
revocation). Senders/templates/SMTP/suppressions already have delete routes and
are out of scope.

## Decisions (locked)

1. **Tenant delete:** super-admin only. Cascades all tenant data. UI requires
   type-the-slug-to-confirm.
2. **User delete:** tenant_admin (within their own tenant) or super-admin. Guards:
   cannot delete yourself; cannot delete a tenant's last `tenant_admin`; target
   must belong to the active tenant.
3. **API-key delete:** permanent delete allowed only when the key is already
   revoked (`revoked_at IS NOT NULL`). Deleting a master cascades its sub-keys.
   Soft-revoke (`DELETE /api/api-keys/:id`) is unchanged.

## Critical technical findings (shape the implementation)

- **Sessions are not re-validated per request.** `server/src/auth/ctx.ts` builds
  `req.ctx` from the session cookie's `userId`/`role`/`tenantId` without re-checking
  the DB. Therefore deleting a user or tenant MUST also delete the affected
  `sessions` rows, or the deleted principal keeps access until cookie expiry.
  Sessions are connect-pg-simple rows (`sid`, `sess jsonb`, `expire`); target via
  `sess->>'userId'` / `sess->>'tenantId'`.
- **`emails.api_key_id` FK has no cascade** (NO ACTION). A key that sent email
  can't be hard-deleted while those rows reference it. Migration changes this FK to
  `ON DELETE SET NULL` so a key can be deleted while its email-log history survives.
  (Tenant cascade is unaffected — all tenant children share `tenant_id ON DELETE
  CASCADE`, and intra-tenant NO ACTION FKs resolve fine when parent + child are
  deleted in the same statement.)

## Backend

**Migration `..._007_emails_apikey_setnull.cjs`:** drop the existing
`emails.api_key_id` FK and re-add it `REFERENCES api_keys(id) ON DELETE SET NULL`.

**`repos/tenants.ts`:** `deleteTenant(pool, id)` — runs in a transaction:
`DELETE FROM sessions WHERE sess->>'tenantId' = $1`, then `DELETE FROM tenants
WHERE id = $1` (returns whether a row was deleted).

**`repos/users.ts`:**
- `getUserById(pool, id)` → `{ id, tenant_id, role }` or null.
- `countTenantAdmins(pool, tenantId)` → number of `tenant_admin` users in tenant.
- `deleteUser(pool, id)` — transaction: `DELETE FROM sessions WHERE sess->>'userId'
  = $1`, then `DELETE FROM users WHERE id = $1`; returns deleted boolean.

**`repos/apiKeys.ts`:** `deleteApiKeyPermanent(pool, tenantId, id)` —
`DELETE FROM api_keys WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NOT NULL`
(sub-keys removed via `parent_id ON DELETE CASCADE`); returns deleted boolean.

**Routes:**
- `adminTenants.ts`: `DELETE /api/admin/tenants/:id` — `requireSuperAdmin`; 404 if
  missing; calls `deleteTenant`.
- `users.ts`: `DELETE /api/users/:id` — `requireTenantCtx` + role ∈
  {`tenant_admin`,`super_admin`}; load target via `getUserById`; 404 if missing or
  `target.tenant_id !== ctx.tenantId`; 400 if `id === ctx.userId` (self) ; 400 if
  target is `tenant_admin` and `countTenantAdmins(tenant) <= 1` (last admin); then
  `deleteUser`.
- `apiKeys.ts`: `DELETE /api/api-keys/:id/permanent` — `requireTenantCtx`; calls
  `deleteApiKeyPermanent`; 404 if not found or not revoked (so active keys can't be
  hard-deleted).

## UI

- **AdminTenants.tsx** (super-admin page): per-row "Delete" → confirm modal that
  requires typing the tenant slug; calls `DELETE /api/admin/tenants/:id`; toast +
  refresh.
- **Users.tsx:** per-row "Delete" (shown when `user.role` ∈ {tenant_admin,
  super_admin}); hidden for the current user's own row; confirm dialog; calls
  `DELETE /api/users/:id`; toast + refresh. (Server still enforces all guards.)
- **ApiKeys.tsx:** revoked rows get a "Delete" button (danger) → confirm → `DELETE
  /api/api-keys/:id/permanent`; toast + refresh. Active rows keep Revoke / Add
  sub-key.

## Permissions / auth

- Reuse `requireSuperAdmin` and `requireTenantCtx` from `auth/ctx.ts`.
- All tenant-scoped deletes are bounded by `ctx.tenantId`; tenant delete bounded by
  super-admin. No new auth primitives.

## Testing (Vitest, serial, Neon test branch)

- **Tenant:** super-admin deletes a tenant → tenant + its users/keys/senders gone;
  non-super-admin (tenant_admin) → 403; tenant's sessions removed.
- **User:** tenant_admin deletes a tenant_user → gone + sessions cleared; cannot
  delete self (400); cannot delete last tenant_admin (400); cannot delete a user in
  another tenant (404); tenant_user role cannot delete (403).
- **API key:** delete a revoked key → gone; deleting an active (non-revoked) key →
  404/blocked; deleting a revoked master removes its sub-keys; an email row that
  referenced a deleted key now has `api_key_id = NULL` (survives).

## Security

Destructive + auth-touching → run `security-review` after implementation. Focus:
tenant scoping on every delete, no cross-tenant deletion, privilege boundaries
(tenant_user cannot delete; tenant_admin can't escalate), session invalidation
closes the deleted-principal-still-authed gap, and the revoked-only guard on key
deletion.

## Out of scope

- Soft-delete / undo / audit log (hard delete only).
- Deleting senders/templates/SMTP/suppressions (already exist).
- Bulk delete.
