import type pg from 'pg';

export interface SyncStateRow {
  imap_config_id: string;
  folder: string;
  uid_validity: string;   // bigint as string
  last_seen_uid: string;  // bigint as string
  last_synced_at: string | null;
}

export async function getSyncState(
  pool: pg.Pool, imapConfigId: string, folder: string,
): Promise<SyncStateRow | null> {
  const r = await pool.query<SyncStateRow>(
    `SELECT imap_config_id, folder, uid_validity, last_seen_uid, last_synced_at
     FROM imap_sync_state WHERE imap_config_id = $1 AND folder = $2`,
    [imapConfigId, folder],
  );
  return r.rows[0] ?? null;
}

export async function upsertSyncState(
  pool: pg.Pool, imapConfigId: string, folder: string,
  state: { uidValidity: number; lastSeenUid: number },
): Promise<void> {
  await pool.query(
    `INSERT INTO imap_sync_state(imap_config_id, folder, uid_validity, last_seen_uid, last_synced_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (imap_config_id, folder)
     DO UPDATE SET uid_validity = EXCLUDED.uid_validity,
                   last_seen_uid = EXCLUDED.last_seen_uid,
                   last_synced_at = now()`,
    [imapConfigId, folder, state.uidValidity, state.lastSeenUid],
  );
}
