import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createContact } from '../src/repos/contacts.js';
import { compileFilter, previewSegment, listSegmentContactIds } from '../src/repos/segments.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('segment compiler', () => {
  it('numbers params from startIndex (no off-by-one)', () => {
    const { sql, params } = compileFilter({ op: 'and', rules: [{ field: 'email', cmp: 'contains', value: 'x' }] }, 2);
    expect(sql).toContain('$2');
    expect(params).toEqual(['%x%']);
  });

  it('skips unsafe attribute keys (SQL-injection guard)', () => {
    const { sql, params } = compileFilter({ op: 'and', rules: [{ field: "a';DROP TABLE contacts;--", cmp: 'eq', value: '1' }] });
    expect(sql).toBe('true');
    expect(params).toEqual([]);
  });

  it('previews matching contacts by standard + attribute filters', async () => {
    const t = await createTenant(pool);
    await createContact(pool, { tenantId: t.id, email: 'pro@x.com', attributes: { plan: 'pro' } });
    await createContact(pool, { tenantId: t.id, email: 'free@x.com', attributes: { plan: 'free' } });

    const p = await previewSegment(pool, t.id, { op: 'and', rules: [{ field: 'plan', cmp: 'eq', value: 'pro' }] });
    expect(p.count).toBe(1);
    expect(p.sample[0].email).toBe('pro@x.com');

    const ids = await listSegmentContactIds(pool, t.id, { op: 'and', rules: [{ field: 'email', cmp: 'contains', value: 'pro' }] });
    expect(ids).toHaveLength(1);
  });
});
