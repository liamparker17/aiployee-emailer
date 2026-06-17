// Throwaway diagnostic: report DB + per-table sizes and row counts.
const fs = require('fs');
const { Client } = require('pg');

(async () => {
  const which = process.argv[2] === 'test' ? '.aiployee-test-db-url' : '.aiployee-prod-db-url';
  const home = process.env.HOME || process.env.USERPROFILE;
  const url = fs.readFileSync(`${home}/${which}`, 'utf8').trim();
  const c = new Client({ connectionString: url });
  await c.connect();

  const dbSize = await c.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS db`);
  console.log('DB logical size:', dbSize.rows[0].db);

  const sizes = await c.query(`
    SELECT
      c.relname AS table,
      pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
      pg_size_pretty(pg_relation_size(c.oid)) AS data,
      pg_size_pretty(pg_total_relation_size(c.oid) - pg_relation_size(c.oid)) AS toast_idx,
      c.reltuples::bigint AS approx_rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY pg_total_relation_size(c.oid) DESC
    LIMIT 25;
  `);
  console.table(sizes.rows);
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
