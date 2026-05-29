import type pg from 'pg';
import type { ContactRow } from './contacts.js';

export interface ListRow { id: string; tenant_id: string; name: string; created_at: Date; member_count: number }

export async function listLists(pool: pg.Pool, tenantId: string): Promise<ListRow[]> {
  const r = await pool.query<ListRow>(
    `SELECT l.id, l.tenant_id, l.name, l.created_at,
       (SELECT count(*)::int FROM contact_list_members m WHERE m.list_id = l.id) AS member_count
     FROM contact_lists l WHERE l.tenant_id = $1 ORDER BY l.created_at DESC`, [tenantId]);
  return r.rows;
}

export async function getList(pool: pg.Pool, tenantId: string, id: string): Promise<ListRow | null> {
  const r = await pool.query<ListRow>(
    `SELECT l.id, l.tenant_id, l.name, l.created_at,
       (SELECT count(*)::int FROM contact_list_members m WHERE m.list_id = l.id) AS member_count
     FROM contact_lists l WHERE l.tenant_id = $1 AND l.id = $2`, [tenantId, id]);
  return r.rows[0] ?? null;
}

export async function createList(pool: pg.Pool, tenantId: string, name: string): Promise<ListRow> {
  const r = await pool.query<{ id: string; tenant_id: string; name: string; created_at: Date }>(
    `INSERT INTO contact_lists(tenant_id, name) VALUES ($1,$2) RETURNING id, tenant_id, name, created_at`, [tenantId, name]);
  return { ...r.rows[0], member_count: 0 };
}

export async function deleteList(pool: pg.Pool, tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM contact_lists WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return r.rowCount === 1;
}

/** Add contacts to a list. Only contacts + list belonging to the tenant are added; dups ignored. */
export async function addMembers(pool: pg.Pool, tenantId: string, listId: string, contactIds: string[]): Promise<number> {
  if (!contactIds.length) return 0;
  const r = await pool.query(
    `INSERT INTO contact_list_members(list_id, contact_id)
     SELECT $1, c.id FROM contacts c
     WHERE c.tenant_id = $2 AND c.id = ANY($3::uuid[])
       AND EXISTS (SELECT 1 FROM contact_lists l WHERE l.id = $1 AND l.tenant_id = $2)
     ON CONFLICT DO NOTHING`,
    [listId, tenantId, contactIds]);
  return r.rowCount ?? 0;
}

export async function removeMember(pool: pg.Pool, tenantId: string, listId: string, contactId: string): Promise<boolean> {
  const r = await pool.query(
    `DELETE FROM contact_list_members m USING contact_lists l
     WHERE m.list_id = l.id AND l.tenant_id = $1 AND m.list_id = $2 AND m.contact_id = $3`,
    [tenantId, listId, contactId]);
  return (r.rowCount ?? 0) > 0;
}

export async function listMembers(pool: pg.Pool, tenantId: string, listId: string): Promise<ContactRow[]> {
  const r = await pool.query<ContactRow>(
    `SELECT c.id, c.tenant_id, c.email, c.name, c.attributes, c.subscribed, c.unsubscribed_at, c.created_at
     FROM contact_list_members m JOIN contacts c ON c.id = m.contact_id
     WHERE c.tenant_id = $1 AND m.list_id = $2 ORDER BY c.email`, [tenantId, listId]);
  return r.rows;
}
