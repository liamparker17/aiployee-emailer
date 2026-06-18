import pg from 'pg';
import type { Config } from '../config.js';
import { SUPABASE_CA_CERT } from './supabaseCa.js';

let pool: pg.Pool | null = null;

export function getPool(cfg: Config): pg.Pool {
  if (!pool) {
    // Supabase's pooler cert chains to its own "Root 2021" CA, which isn't in
    // Node's default trust store. Pin that CA so the connection is fully
    // verified (chain + hostname). Other hosts (e.g. the Neon test branch) use
    // a publicly-trusted cert, so we leave Node's default verification via the
    // connection string's sslmode in place.
    const isSupabase = /supabase\.(co|com)/i.test(cfg.databaseUrl);

    // max: 10 — connections fan in through Supabase's Supavisor transaction
    // pooler (serverless), so a large per-instance pool is pointless and risks
    // exhausting the upstream limit under cron load.
    pool = new pg.Pool({
      connectionString: cfg.databaseUrl,
      max: 10,
      ...(isSupabase
        ? { ssl: { ca: SUPABASE_CA_CERT, rejectUnauthorized: true } }
        : {}),
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
}
