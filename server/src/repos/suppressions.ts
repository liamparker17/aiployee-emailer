import type pg from 'pg';

export interface SuppressionRow { id: string; tenant_id: string; address: string; reason: string; created_at: Date }

export async function isSuppressed(pool: pg.Pool, tenantId: string, address: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM suppressions WHERE tenant_id = $1 AND lower(address) = lower($2)`,
    [tenantId, address]);
  return (r.rowCount ?? 0) > 0;
}

export async function addSuppression(pool: pg.Pool, input: {
  tenantId: string; address: string; reason: 'bounce' | 'complaint' | 'manual';
}): Promise<void> {
  await pool.query(
    `INSERT INTO suppressions(tenant_id, address, reason)
     VALUES ($1, lower($2), $3)
     ON CONFLICT (tenant_id, address) DO NOTHING`,
    [input.tenantId, input.address, input.reason]);
}

export async function listSuppressions(pool: pg.Pool, tenantId: string): Promise<SuppressionRow[]> {
  const r = await pool.query<SuppressionRow>(
    `SELECT id, tenant_id, address, reason, created_at
     FROM suppressions WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return r.rows;
}

export async function removeSuppression(pool: pg.Pool, tenantId: string, address: string): Promise<boolean> {
  const r = await pool.query(
    `DELETE FROM suppressions WHERE tenant_id = $1 AND lower(address) = lower($2)`,
    [tenantId, address]);
  return r.rowCount === 1;
}
