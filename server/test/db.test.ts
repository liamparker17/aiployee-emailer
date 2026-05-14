import { describe, it, expect, afterAll } from 'vitest';
import { makePool } from './helpers/db.js';

const pool = makePool();
afterAll(async () => { await pool.end(); });

describe('db connectivity', () => {
  it('lists migrated tables', async () => {
    const r = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
    );
    const names = r.rows.map(x => x.tablename);
    for (const t of ['tenants','users','sessions','smtp_configs','senders','templates','api_keys','emails','bounce_events','suppressions']) {
      expect(names).toContain(t);
    }
  });
});
