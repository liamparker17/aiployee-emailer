import pg from 'pg';
import type { Config } from '../config.js';

let pool: pg.Pool | null = null;

export function getPool(cfg: Config): pg.Pool {
  if (!pool) pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 25 });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
}
