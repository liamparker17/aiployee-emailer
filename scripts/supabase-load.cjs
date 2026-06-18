// One-shot loader: restore the Neon JSON snapshot (aiployee-neon-backup.json)
// into the freshly-migrated Supabase database. Type-aware (bytea<-base64,
// json/jsonb stringified, arrays passed through), skips generated columns and
// pgmigrations, disables FK triggers during load, and truncates first so any
// migration seed rows don't collide with snapshot rows.
const fs = require('fs');
const { Client } = require('pg');

(async () => {
  const home = process.env.HOME || process.env.USERPROFILE;
  const snap = JSON.parse(fs.readFileSync(`${home}/aiployee-neon-backup.json`, 'utf8'));
  const sessionLine = fs.readFileSync(`${home}/.aiployee-supabase-url`, 'utf8')
    .split(/\r?\n/).find(l => l.startsWith('SESSION='));
  if (!sessionLine) throw new Error('SESSION= line not found in .aiployee-supabase-url');
  const connectionString = sessionLine.slice('SESSION='.length).trim().split('?')[0];
  const ca = fs.readFileSync(`${home}/.aiployee-supabase-ca.pem`, 'utf8');

  const c = new Client({ connectionString, ssl: { ca, rejectUnauthorized: true } });
  await c.connect();

  // Column metadata per table: type + whether generated (skip generated cols).
  const meta = {};
  const cols = await c.query(`
    SELECT table_name, column_name, udt_name, is_generated
    FROM information_schema.columns
    WHERE table_schema = 'public'`);
  for (const r of cols.rows) {
    (meta[r.table_name] ||= {})[r.column_name] = { udt: r.udt_name, generated: r.is_generated !== 'NEVER' };
  }

  const SKIP = new Set(['pgmigrations']);
  const tables = Object.keys(snap.tables).filter(t => !SKIP.has(t) && meta[t]);

  await c.query(`SET session_replication_role = 'replica'`); // FK/triggers off
  await c.query(`TRUNCATE ${tables.map(t => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);

  const coerce = (val, info) => {
    if (val === null || val === undefined) return null;
    if (val && typeof val === 'object' && val.__b64 !== undefined) return Buffer.from(val.__b64, 'base64');
    if (info && (info.udt === 'jsonb' || info.udt === 'json')) return JSON.stringify(val);
    return val; // strings, numbers, bools, and real arrays pass through
  };

  const results = [];
  for (const t of tables) {
    const rows = snap.tables[t];
    if (!rows || rows.length === 0) { results.push([t, 0, 0]); continue; }
    // Insert columns = snapshot keys minus generated columns.
    const colNames = Object.keys(rows[0]).filter(k => !(meta[t][k] && meta[t][k].generated));
    const colList = colNames.map(k => `"${k}"`).join(', ');
    let ok = 0;
    for (const row of rows) {
      const params = colNames.map((k, i) => coerce(row[k], meta[t][k]));
      const ph = colNames.map((_, i) => `$${i + 1}`).join(', ');
      await c.query(`INSERT INTO "${t}" (${colList}) VALUES (${ph})`, params);
      ok++;
    }
    results.push([t, rows.length, ok]);
    console.log(`  ${t}: ${ok}/${rows.length}`);
  }

  await c.query(`SET session_replication_role = 'origin'`); // FK/triggers back on
  await c.end();

  const mismatched = results.filter(([, want, got]) => want !== got);
  console.log(`\nLoaded ${results.length} tables; ${results.reduce((s, r) => s + r[2], 0)} rows total.`);
  if (mismatched.length) { console.error('MISMATCHES:', mismatched); process.exit(1); }
  console.log('All row counts match the snapshot.');
})().catch(e => { console.error('LOAD ERROR:', e.message); process.exit(1); });
