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
