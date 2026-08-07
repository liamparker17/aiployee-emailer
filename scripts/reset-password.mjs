// Emergency password reset straight against the prod DB — the escape hatch for a
// locked-out super_admin. Usage: node scripts/reset-password.mjs <email>
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const email = process.argv[2];
if (!email) { console.error('usage: node scripts/reset-password.mjs <email>'); process.exit(1); }

const url = readFileSync(join(homedir(), '.aiployee-prod-db-url'), 'utf8').trim();
const tempPassword = randomBytes(9).toString('base64url'); // 12 chars, URL-safe
const hash = await bcrypt.hash(tempPassword, 10);

const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
const r = await pool.query(
  `UPDATE users SET password_hash = $2 WHERE lower(email) = lower($1)
   RETURNING id, email, role, tenant_id`,
  [email.trim(), hash],
);
await pool.end();

if (r.rowCount === 0) { console.error('No user found for', email); process.exit(1); }
for (const row of r.rows) console.log(`updated: ${row.email} role=${row.role} tenant=${row.tenant_id ?? 'NULL'}`);
console.log('TEMP PASSWORD:', tempPassword);
