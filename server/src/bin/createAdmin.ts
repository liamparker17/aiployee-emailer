import 'dotenv/config';
import { loadConfig } from '../config.js';
import { getPool, closePool } from '../db/pool.js';
import { hashPassword } from '../auth/password.js';

const [, , email, password] = process.argv;
if (!email || !password) {
  console.error('usage: node dist/bin/createAdmin.js <email> <password>');
  process.exit(1);
}
const cfg = loadConfig();
const pool = getPool(cfg);
const hash = await hashPassword(password);
await pool.query(
  `INSERT INTO users(tenant_id,email,password_hash,role)
   VALUES (NULL, $1, $2, 'super_admin')
   ON CONFLICT (tenant_id, email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
  [email.trim().toLowerCase(), hash]);
console.log('super_admin ready:', email);
await closePool();
