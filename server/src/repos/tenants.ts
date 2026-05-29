import type pg from 'pg';

export interface Tenant { id: string; name: string; slug: string; created_at: Date }

export async function createTenant(pool: pg.Pool, input: { name: string; slug: string }): Promise<Tenant> {
  const r = await pool.query<Tenant>(
    `INSERT INTO tenants(name, slug) VALUES ($1, $2) RETURNING id, name, slug, created_at`,
    [input.name, input.slug],
  );
  return r.rows[0];
}

export async function listTenants(pool: pg.Pool): Promise<Tenant[]> {
  const r = await pool.query<Tenant>(`SELECT id, name, slug, created_at FROM tenants ORDER BY created_at DESC`);
  return r.rows;
}

export async function getTenant(pool: pg.Pool, id: string): Promise<Tenant | null> {
  const r = await pool.query<Tenant>(`SELECT id, name, slug, created_at FROM tenants WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

/**
 * Permanently delete a tenant and all its data. FKs (tenant_id ON DELETE CASCADE)
 * remove senders, smtp_configs, templates, api_keys, emails, suppressions, and
 * users. We also clear the tenant members' sessions (no FK on the sessions table)
 * so a deleted tenant's users can't keep acting on a stale cookie. Returns whether
 * the tenant row existed.
 */
export async function deleteTenant(pool: pg.Pool, id: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM sessions WHERE sess->>'tenantId' = $1`, [id]);
    const r = await client.query(`DELETE FROM tenants WHERE id = $1`, [id]);
    await client.query('COMMIT');
    return r.rowCount === 1;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
