import pg from 'pg';

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer';

export function makePool(): pg.Pool {
  return new pg.Pool({ connectionString: TEST_DB_URL, max: 4 });
}

export async function truncateAll(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'pgmigrations'`
  );
  if (rows.length === 0) return;
  const list = rows.map(r => `"${r.tablename}"`).join(', ');
  await pool.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}
