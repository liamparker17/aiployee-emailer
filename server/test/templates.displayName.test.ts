import { it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createTemplate, updateTemplate, getTemplateByName } from '@aiployee/core';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

it('template display_name round-trips: set, preserve, clear', async () => {
  const t = await createTenant(pool);
  const c = await createTemplate(pool, { tenantId: t.id, name: 'absa_line', subject: 'S', bodyHtml: '<p>x</p>', displayName: '  First Assist Absa Line  ' });
  expect(c.display_name).toBe('First Assist Absa Line'); // trimmed
  const u1 = await updateTemplate(pool, t.id, c.id, { subject: 'S2' });        // omit preserves
  expect(u1?.display_name).toBe('First Assist Absa Line');
  const u2 = await updateTemplate(pool, t.id, c.id, { displayName: null });    // null clears
  expect(u2?.display_name).toBeNull();
  expect((await getTemplateByName(pool, t.id, 'absa_line'))?.display_name).toBeNull();
});
