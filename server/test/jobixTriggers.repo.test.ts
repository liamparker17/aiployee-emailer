import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createTrigger, listTriggers, getTriggerForFire, updateTrigger, deleteTrigger } from '../src/repos/jobixTriggers.js';

const KEY = Buffer.alloc(32, 9);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

const base = { label: 'Callback', token: 'jbx-secret-token', tokenPlacement: 'bearer' as const, payloadTemplate: '{"name":"{{name}}"}' };

describe('jobixTriggers repo', () => {
  it('creates a trigger, encrypts the token, never returns it, defaults the url', async () => {
    const t = await createTenant(pool);
    const trig = await createTrigger(pool, KEY, { tenantId: t.id, ...base });
    expect(trig.url).toBe('https://dashboard-api.jobix.ai/automation/trigger/webhook');
    expect(trig.hasToken).toBe(true);
    expect(JSON.stringify(trig)).not.toContain('jbx-secret-token');
    const list = await listTriggers(pool, t.id);
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list[0])).not.toContain('jbx-secret-token');
  });

  it('getTriggerForFire decrypts the token (server-only)', async () => {
    const t = await createTenant(pool);
    const trig = await createTrigger(pool, KEY, { tenantId: t.id, ...base });
    const f = await getTriggerForFire(pool, KEY, t.id, trig.id);
    expect(f?.token).toBe('jbx-secret-token');
    expect(f?.tokenPlacement).toBe('bearer');
  });

  it('rejects a non-bearer placement without token_param', async () => {
    const t = await createTenant(pool);
    await expect(createTrigger(pool, KEY, { tenantId: t.id, ...base, tokenPlacement: 'header' }))
      .rejects.toThrow();
  });

  it('rejects an http url', async () => {
    const t = await createTenant(pool);
    await expect(createTrigger(pool, KEY, { tenantId: t.id, ...base, url: 'http://x.io/y' }))
      .rejects.toThrow();
  });

  it('updateTrigger rotates the token and toggles active', async () => {
    const t = await createTenant(pool);
    const trig = await createTrigger(pool, KEY, { tenantId: t.id, ...base });
    await updateTrigger(pool, KEY, t.id, trig.id, { token: 'new-token', active: false });
    const f = await getTriggerForFire(pool, KEY, t.id, trig.id);
    expect(f?.token).toBe('new-token');
    expect(f?.active).toBe(false);
  });

  it('deleteTrigger removes it; cross-tenant getTriggerForFire returns null', async () => {
    const t1 = await createTenant(pool); const t2 = await createTenant(pool);
    const trig = await createTrigger(pool, KEY, { tenantId: t1.id, ...base });
    expect(await getTriggerForFire(pool, KEY, t2.id, trig.id)).toBeNull();
    expect(await deleteTrigger(pool, t1.id, trig.id)).toBe(true);
    expect(await getTriggerForFire(pool, KEY, t1.id, trig.id)).toBeNull();
  });
});
