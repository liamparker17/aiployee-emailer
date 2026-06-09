import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createContact, importContacts, listContacts } from '@aiployee/core';
import { createList, addMembers, listMembers, removeMember, listLists } from '@aiployee/core';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('contacts', () => {
  it('imports and merges attributes (case-insensitive upsert)', async () => {
    const t = await createTenant(pool);
    await importContacts(pool, t.id, [{ email: 'A@X.com', name: 'A', attributes: { plan: 'pro' } }]);
    await importContacts(pool, t.id, [{ email: 'a@x.com', attributes: { region: 'ZA' } }]);
    const list = await listContacts(pool, t.id);
    expect(list).toHaveLength(1);
    expect(list[0].email).toBe('a@x.com');
    expect(list[0].attributes).toMatchObject({ plan: 'pro', region: 'ZA' });
  });

  it('search filters by email/name', async () => {
    const t = await createTenant(pool);
    await createContact(pool, { tenantId: t.id, email: 'jane@x.com', name: 'Jane' });
    await createContact(pool, { tenantId: t.id, email: 'bob@y.com', name: 'Bob' });
    expect(await listContacts(pool, t.id, { search: 'jane' })).toHaveLength(1);
  });
});

describe('lists', () => {
  it('adds members tenant-scoped (ignores foreign contacts) and removes', async () => {
    const t = await createTenant(pool);
    const other = await createTenant(pool);
    const c1 = await createContact(pool, { tenantId: t.id, email: 'a@x.com' });
    const foreign = await createContact(pool, { tenantId: other.id, email: 'f@x.com' });
    const l = await createList(pool, t.id, 'L');

    const added = await addMembers(pool, t.id, l.id, [c1.id, foreign.id]);
    expect(added).toBe(1); // foreign contact not added
    expect((await listMembers(pool, t.id, l.id)).map(m => m.email)).toEqual(['a@x.com']);
    expect((await listLists(pool, t.id))[0].member_count).toBe(1);

    expect(await removeMember(pool, t.id, l.id, c1.id)).toBe(true);
    expect(await listMembers(pool, t.id, l.id)).toHaveLength(0);
  });
});
