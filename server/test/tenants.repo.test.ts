import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant as create } from '@aiployee/core';
import { listTenants } from '@aiployee/core';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('tenants repo', () => {
  it('creates and lists', async () => {
    const t = await create(pool, { name: 'Acme', slug: 'acme' });
    expect(t.name).toBe('Acme');
    const all = await listTenants(pool);
    expect(all).toHaveLength(1);
  });
  it('rejects duplicate slug', async () => {
    await create(pool, { name: 'A', slug: 'dup' });
    await expect(create(pool, { name: 'B', slug: 'dup' })).rejects.toThrow();
  });
});
