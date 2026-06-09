import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createTemplate, updateTemplate, listTemplates } from '@aiployee/core';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('templates repo', () => {
  it('extracts variables on create', async () => {
    const t = await createTenant(pool);
    const tpl = await createTemplate(pool, {
      tenantId: t.id, name: 'welcome',
      subject: 'Hi {{name}}', bodyHtml: '<p>Hello {{name}} from {{company}}</p>',
    });
    expect(tpl.variables.sort()).toEqual(['company', 'name']);
  });

  it('re-extracts variables on update', async () => {
    const t = await createTenant(pool);
    const tpl = await createTemplate(pool, {
      tenantId: t.id, name: 'x', subject: 's', bodyHtml: '<p>{{a}}</p>',
    });
    const upd = await updateTemplate(pool, t.id, tpl.id, { bodyHtml: '<p>{{b}}</p>' });
    expect(upd!.variables).toEqual(['b']);
  });
});
