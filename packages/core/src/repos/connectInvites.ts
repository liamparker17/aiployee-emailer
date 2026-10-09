import type pg from 'pg';
import type { InviteRow, InvitePatch, InviteStore } from '../connect/emailedConnect.js';

const COLS = `id, tenant_id, mailbox, recipient_email, display_name, allow_shared, token_hash, status, expires_at, used_at,
  created_by_user_id, created_by_email, device_code_enc, user_code, verification_uri, device_expires_at, poll_interval,
  next_poll_at, restarts, start_count, mismatch_count, failure_reason, sender_id, connected_at, created_at`;

export async function insertConnectInvite(pool: pg.Pool, i: {
  tenantId: string; mailbox: string; recipientEmail: string; displayName: string; allowShared: boolean;
  tokenHash: string; expiresAt: Date; createdByUserId: string | null; createdByEmail: string;
}): Promise<InviteRow> {
  const r = await pool.query<InviteRow>(
    `INSERT INTO m365_connect_invites(tenant_id, mailbox, recipient_email, display_name, allow_shared, token_hash, expires_at, created_by_user_id, created_by_email)
     VALUES ($1,lower($2),lower($3),$4,$5,$6,$7,$8,$9) RETURNING ${COLS}`,
    [i.tenantId, i.mailbox, i.recipientEmail, i.displayName, i.allowShared, i.tokenHash, i.expiresAt, i.createdByUserId, i.createdByEmail]);
  return r.rows[0];
}

/** Admin listing — never selects token_hash/device_code_enc. */
export async function listConnectInvites(pool: pg.Pool, tenantId: string) {
  const r = await pool.query(
    `SELECT id, mailbox, recipient_email, display_name, allow_shared, status, expires_at, used_at, failure_reason, connected_at, created_at
     FROM m365_connect_invites WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100`, [tenantId]);
  return r.rows;
}

export async function revokeConnectInvite(pool: pg.Pool, tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE m365_connect_invites SET status='revoked', device_code_enc=NULL, user_code=NULL, updated_at=now()
     WHERE id=$1 AND tenant_id=$2 AND status='pending' AND used_at IS NULL`, [id, tenantId]);
  return (r.rowCount ?? 0) > 0;
}

export async function deleteConnectInvite(pool: pg.Pool, id: string): Promise<void> {
  await pool.query(`DELETE FROM m365_connect_invites WHERE id=$1`, [id]);
}

export function pgInviteStore(pool: pg.Pool): InviteStore {
  return {
    async findByTokenHash(hash) {
      const r = await pool.query<InviteRow>(`SELECT ${COLS} FROM m365_connect_invites WHERE token_hash=$1`, [hash]);
      return r.rows[0] ?? null;
    },
    async getById(id) {
      const r = await pool.query<InviteRow>(`SELECT ${COLS} FROM m365_connect_invites WHERE id=$1`, [id]);
      return r.rows[0] ?? null;
    },
    async update(id, patch: InvitePatch) {
      const keys = Object.keys(patch) as Array<keyof InvitePatch>;
      if (!keys.length) return;
      // keys come from our own typed patch objects, never from request input
      const sets = keys.map((k, n) => `${String(k)} = $${n + 2}`).join(', ');
      await pool.query(`UPDATE m365_connect_invites SET ${sets}, updated_at = now() WHERE id = $1`,
        [id, ...keys.map(k => patch[k])]);
    },
    async claimPoll(id, now, nextPollAt) {
      const r = await pool.query(
        `UPDATE m365_connect_invites SET next_poll_at=$3, updated_at=now()
         WHERE id=$1 AND status='pending' AND used_at IS NULL AND (next_poll_at IS NULL OR next_poll_at <= $2)`,
        [id, now, nextPollAt]);
      return (r.rowCount ?? 0) > 0;
    },
    async finalize(id, now, senderId) {
      const r = await pool.query(
        `UPDATE m365_connect_invites SET status='connected', used_at=$2, connected_at=$2, sender_id=$3, failure_reason=NULL, updated_at=now()
         WHERE id=$1 AND status='pending' AND used_at IS NULL`, [id, now, senderId]);
      return (r.rowCount ?? 0) > 0;
    },
  };
}
