// Read-only: does the platform password-reset sender exist and look usable?
// Usage: node scripts/check-reset-sender.mjs [email]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const email = process.argv[2] ?? 'liam@aiployee.co.za';
const url = readFileSync(join(homedir(), '.aiployee-prod-db-url'), 'utf8').trim();
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

const s = await pool.query(
  `SELECT id, tenant_id, email, display_name, smtp_config_id, is_default
     FROM senders WHERE lower(email) = lower($1)`, [email]);
console.log(`senders matching ${email}: ${s.rowCount}`);
for (const r of s.rows) console.log('  ', JSON.stringify(r));
if (s.rowCount === 0) console.log('  !! no sender — reset mail cannot be sent from this address');
else if (!s.rows[0].smtp_config_id) console.log('  !! sender has no SMTP config — sending will fail');

const u = await pool.query(`SELECT id, tenant_id, role FROM users WHERE lower(email) = lower($1)`, [email]);
console.log(`user rows for ${email}: ${u.rowCount}`);
for (const r of u.rows) console.log('  ', JSON.stringify(r));

await pool.end();
