// Validates the real committed runtime DB path (packages/core getPool: CA
// pinning + max:10) against Supabase's transaction pooler (6543) — i.e. exactly
// what the serverless app does in production. Run after building core.
import { getPool, closePool } from '../packages/core/dist/db/pool.js';
import fs from 'node:fs';

const home = process.env.USERPROFILE || process.env.HOME;
const txn = fs.readFileSync(`${home}/.aiployee-supabase-url`, 'utf8')
  .split(/\r?\n/).find(l => l.startsWith('TXN=')).slice('TXN='.length).trim();

const pool = getPool({ databaseUrl: txn });
const r = await pool.query(
  `select current_database() as db,
          (select count(*) from tenants) as tenants,
          (select count(*) from users) as users,
          (select count(*) from emails) as emails`
);
console.log('RUNTIME DB OK (transaction pooler 6543, CA-verified):', r.rows[0]);
await closePool();
