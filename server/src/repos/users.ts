import type pg from 'pg';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../auth/password.js';
import type { Role } from '@aiployee/shared';

export interface User { id: string; tenant_id: string | null; email: string; role: Role }

export async function createInvitedUser(pool: pg.Pool, input: {
  tenantId: string | null; email: string; role: Role; ttlMinutes?: number;
}): Promise<{ user: User; inviteToken: string }> {
  const token = randomBytes(24).toString('base64url');
  const placeholderHash = await hashPassword(randomBytes(16).toString('hex'));
  const ttl = input.ttlMinutes ?? 60 * 24 * 7;
  const r = await pool.query<User>(
    `INSERT INTO users(tenant_id,email,password_hash,role,invite_token,invite_expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' minutes')::interval)
     RETURNING id, tenant_id, email, role`,
    [input.tenantId, input.email, placeholderHash, input.role, token, String(ttl)],
  );
  return { user: r.rows[0], inviteToken: token };
}

export async function listUsersForTenant(pool: pg.Pool, tenantId: string): Promise<User[]> {
  const r = await pool.query<User>(
    `SELECT id, tenant_id, email, role FROM users WHERE tenant_id = $1 ORDER BY email`, [tenantId]);
  return r.rows;
}
