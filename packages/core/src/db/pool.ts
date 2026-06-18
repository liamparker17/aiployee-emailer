import pg from 'pg';
import type { Config } from '../config.js';

let pool: pg.Pool | null = null;

export function getPool(cfg: Config): pg.Pool {
  // max: 10 — connections fan in through Supabase's Supavisor transaction
  // pooler (serverless), so a large per-instance pool is pointless and risks
  // exhausting the upstream limit under cron load.
  if (!pool) pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 10 });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
}
