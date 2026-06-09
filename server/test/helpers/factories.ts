import type pg from 'pg';
import { hashPassword } from '@aiployee/core';

export async function createTenant(pool: pg.Pool, name = 'Tenant ' + Math.random().toString(36).slice(2, 7)) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const r = await pool.query<{ id: string; name: string; slug: string }>(
    `INSERT INTO tenants(name, slug) VALUES ($1,$2) RETURNING *`, [name, slug]);
  return r.rows[0];
}

export async function createUser(pool: pg.Pool, opts: {
  tenantId: string | null; email: string; password?: string; role: 'super_admin' | 'tenant_admin' | 'tenant_user';
}) {
  const hash = await hashPassword(opts.password ?? 'pw-' + Math.random());
  const r = await pool.query<{ id: string; email: string; role: string; tenant_id: string | null }>(
    `INSERT INTO users(tenant_id,email,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id,email,role,tenant_id`,
    [opts.tenantId, opts.email, hash, opts.role]);
  return r.rows[0];
}
