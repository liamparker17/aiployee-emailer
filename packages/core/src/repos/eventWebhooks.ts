import type pg from 'pg';
import { encrypt, decrypt } from '@aiployee/core';

export interface EventWebhookRow {
  id: string;
  tenant_id: string;
  url: string;
  events: string[];
  enabled: boolean;
  has_secret: boolean;
  created_at: Date;
}

export interface EventWebhookTarget {
  url: string;
  secret: string;
}

export async function listEventWebhooks(pool: pg.Pool, tenantId: string): Promise<EventWebhookRow[]> {
  const r = await pool.query<EventWebhookRow>(
    `SELECT id, tenant_id, url, events, enabled,
            (secret_encrypted IS NOT NULL) AS has_secret, created_at
     FROM event_webhooks
     WHERE tenant_id = $1
     ORDER BY created_at ASC`,
    [tenantId],
  );
  return r.rows;
}

export async function createEventWebhook(
  pool: pg.Pool,
  key: Buffer,
  args: { tenantId: string; url: string; events: string[]; secret: string },
): Promise<EventWebhookRow> {
  const secretEncrypted = encrypt(args.secret, key);
  const r = await pool.query<EventWebhookRow>(
    `INSERT INTO event_webhooks (tenant_id, url, secret_encrypted, events)
     VALUES ($1, $2, $3, $4)
     RETURNING id, tenant_id, url, events, enabled,
               (secret_encrypted IS NOT NULL) AS has_secret, created_at`,
    [args.tenantId, args.url, secretEncrypted, args.events],
  );
  return r.rows[0];
}

export async function deleteEventWebhook(
  pool: pg.Pool,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const r = await pool.query(
    `DELETE FROM event_webhooks WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function listTargetsForEvent(
  pool: pg.Pool,
  key: Buffer,
  tenantId: string,
  event: string,
): Promise<EventWebhookTarget[]> {
  const r = await pool.query<{ url: string; secret_encrypted: Buffer }>(
    `SELECT url, secret_encrypted
     FROM event_webhooks
     WHERE tenant_id = $1
       AND enabled = true
       AND $2 = ANY(events)`,
    [tenantId, event],
  );
  return r.rows.map(row => ({
    url: row.url,
    secret: decrypt(row.secret_encrypted, key),
  }));
}
