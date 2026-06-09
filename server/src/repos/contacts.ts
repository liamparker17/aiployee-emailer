import type pg from 'pg';

export interface ContactRow {
  id: string; tenant_id: string; email: string; name: string | null;
  attributes: Record<string, unknown>; subscribed: boolean;
  unsubscribed_at: Date | null; created_at: Date;
}
const COLS = 'id, tenant_id, email, name, attributes, subscribed, unsubscribed_at, created_at';

export async function listContacts(pool: pg.Pool, tenantId: string, opts: { search?: string; limit?: number } = {}): Promise<ContactRow[]> {
  const params: unknown[] = [tenantId];
  let where = 'tenant_id = $1';
  if (opts.search) {
    params.push(`%${opts.search.toLowerCase()}%`);
    where += ` AND (lower(email) LIKE $${params.length} OR lower(coalesce(name,'')) LIKE $${params.length})`;
  }
  params.push(Math.min(opts.limit ?? 200, 1000));
  const r = await pool.query<ContactRow>(
    `SELECT ${COLS} FROM contacts WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
  return r.rows;
}

export async function createContact(pool: pg.Pool, input: { tenantId: string; email: string; name?: string | null; attributes?: Record<string, unknown> }): Promise<ContactRow> {
  const r = await pool.query<ContactRow>(
    `INSERT INTO contacts(tenant_id, email, name, attributes) VALUES ($1,$2,$3,$4) RETURNING ${COLS}`,
    [input.tenantId, input.email.toLowerCase().trim(), input.name ?? null, JSON.stringify(input.attributes ?? {})]);
  return r.rows[0];
}

export async function updateContact(pool: pg.Pool, tenantId: string, id: string, patch: { name?: string | null; attributes?: Record<string, unknown>; subscribed?: boolean }): Promise<ContactRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [tenantId, id];
  if (patch.name !== undefined) { params.push(patch.name); sets.push(`name = $${params.length}`); }
  if (patch.attributes !== undefined) { params.push(JSON.stringify(patch.attributes)); sets.push(`attributes = $${params.length}`); }
  if (patch.subscribed !== undefined) {
    params.push(patch.subscribed); sets.push(`subscribed = $${params.length}`);
    sets.push(`unsubscribed_at = ${patch.subscribed ? 'NULL' : 'now()'}`);
  }
  if (!sets.length) return getContact(pool, tenantId, id);
  const r = await pool.query<ContactRow>(
    `UPDATE contacts SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = $2 RETURNING ${COLS}`, params);
  return r.rows[0] ?? null;
}

export async function getContact(pool: pg.Pool, tenantId: string, id: string): Promise<ContactRow | null> {
  const r = await pool.query<ContactRow>(`SELECT ${COLS} FROM contacts WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return r.rows[0] ?? null;
}

/** Resolve contact ids for a set of emails within a tenant (used after CSV import). */
export async function getContactIdsByEmails(pool: pg.Pool, tenantId: string, emails: string[]): Promise<string[]> {
  const norm = [...new Set(emails.map(e => e.toLowerCase().trim()).filter(e => e.includes('@')))];
  if (!norm.length) return [];
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM contacts WHERE tenant_id = $1 AND email = ANY($2::text[])`, [tenantId, norm]);
  return r.rows.map(row => row.id);
}

/** Fetch contacts by id within a tenant. `subscribedOnly` drops unsubscribed ones (for sending). */
export async function getContactsByIds(pool: pg.Pool, tenantId: string, ids: string[], subscribedOnly = false): Promise<ContactRow[]> {
  if (!ids.length) return [];
  const r = await pool.query<ContactRow>(
    `SELECT ${COLS} FROM contacts WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ${subscribedOnly ? 'AND subscribed = true' : ''}`,
    [tenantId, ids]);
  return r.rows;
}

export async function deleteContact(pool: pg.Pool, tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM contacts WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return r.rowCount === 1;
}

/** Bulk upsert (CSV import). New attributes are merged into any existing ones. Returns count processed. */
export async function importContacts(pool: pg.Pool, tenantId: string, rows: Array<{ email: string; name?: string | null; attributes?: Record<string, unknown> }>): Promise<{ imported: number }> {
  let imported = 0;
  for (const row of rows) {
    const email = (row.email ?? '').toLowerCase().trim();
    if (!email || !email.includes('@')) continue;
    await pool.query(
      `INSERT INTO contacts(tenant_id, email, name, attributes) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, email) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, contacts.name),
         attributes = contacts.attributes || EXCLUDED.attributes`,
      [tenantId, email, row.name ?? null, JSON.stringify(row.attributes ?? {})]);
    imported++;
  }
  return { imported };
}
