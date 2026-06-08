import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createTrigger, updateTrigger, listFires } from '../src/repos/jobixTriggers.js';
import { fireTrigger } from '../src/jobix/fireTrigger.js';

const KEY = Buffer.alloc(32, 9);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); await vi.restoreAllMocks(); });

function okFetch() {
  return vi.fn(async () => new Response(JSON.stringify({ status: 'accepted' }), { status: 200 }));
}

describe('fireTrigger', () => {
  it('renders the template, sends bearer auth, records a fire, sets last_fired_at', async () => {
    const t = await createTenant(pool);
    const tr = await createTrigger(pool, KEY, { tenantId: t.id, label: 'L', token: 'tok-1',
      tokenPlacement: 'bearer', payloadTemplate: '{"name":"{{name}}","phone":"{{phone}}"}' });
    const f = okFetch(); vi.stubGlobal('fetch', f);
    const res = await fireTrigger(pool, KEY, { tenantId: t.id, triggerId: tr.id, vars: { name: 'Renier', phone: '+2760' }, source: 'manual' });
    expect(res.ok).toBe(true);
    expect(res.httpStatus).toBe(200);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://dashboard-api.jobix.ai/automation/trigger/webhook');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok-1', 'Content-Type': 'application/json' });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ name: 'Renier', phone: '+2760' });
    const { fires } = await listFires(pool, t.id, tr.id, {});
    expect(fires).toHaveLength(1);
    expect(fires[0].ok).toBe(true);
    const lf = await pool.query(`SELECT last_fired_at FROM jobix_triggers WHERE id = $1`, [tr.id]);
    expect(lf.rows[0].last_fired_at).not.toBeNull();
  });

  it('applies header placement', async () => {
    const t = await createTenant(pool);
    const tr = await createTrigger(pool, KEY, { tenantId: t.id, label: 'H', token: 'tok-2',
      tokenPlacement: 'header', tokenParam: 'X-Webhook-Token', payloadTemplate: '{}' });
    const f = okFetch(); vi.stubGlobal('fetch', f);
    await fireTrigger(pool, KEY, { tenantId: t.id, triggerId: tr.id, vars: {}, source: 'test' });
    expect((f.mock.calls[0][1] as RequestInit).headers).toMatchObject({ 'X-Webhook-Token': 'tok-2' });
  });

  it('applies query placement', async () => {
    const t = await createTenant(pool);
    const tr = await createTrigger(pool, KEY, { tenantId: t.id, label: 'Q', token: 'tok-3',
      tokenPlacement: 'query', tokenParam: 'token', payloadTemplate: '{}' });
    const f = okFetch(); vi.stubGlobal('fetch', f);
    await fireTrigger(pool, KEY, { tenantId: t.id, triggerId: tr.id, vars: {}, source: 'test' });
    expect(f.mock.calls[0][0]).toContain('token=tok-3');
  });

  it('applies body placement', async () => {
    const t = await createTenant(pool);
    const tr = await createTrigger(pool, KEY, { tenantId: t.id, label: 'B', token: 'tok-4',
      tokenPlacement: 'body', tokenParam: 'token', payloadTemplate: '{"x":1}' });
    const f = okFetch(); vi.stubGlobal('fetch', f);
    await fireTrigger(pool, KEY, { tenantId: t.id, triggerId: tr.id, vars: {}, source: 'test' });
    expect(JSON.parse((f.mock.calls[0][1] as RequestInit).body as string)).toEqual({ x: 1, token: 'tok-4' });
  });

  it('reports invalid_payload when the rendered template is not JSON', async () => {
    const t = await createTenant(pool);
    const tr = await createTrigger(pool, KEY, { tenantId: t.id, label: 'Bad', token: 'k',
      tokenPlacement: 'bearer', payloadTemplate: '{ not json {{name}}' });
    const f = okFetch(); vi.stubGlobal('fetch', f);
    const res = await fireTrigger(pool, KEY, { tenantId: t.id, triggerId: tr.id, vars: { name: 'x' }, source: 'test' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('invalid_payload');
    expect(f).not.toHaveBeenCalled();
    const { fires } = await listFires(pool, t.id, tr.id, {});
    expect(fires[0].ok).toBe(false);
  });

  it('collects unresolved placeholders', async () => {
    const t = await createTenant(pool);
    const tr = await createTrigger(pool, KEY, { tenantId: t.id, label: 'U', token: 'k',
      tokenPlacement: 'bearer', payloadTemplate: '{"a":"{{missing}}"}' });
    vi.stubGlobal('fetch', okFetch());
    const res = await fireTrigger(pool, KEY, { tenantId: t.id, triggerId: tr.id, vars: {}, source: 'test' });
    expect(res.unresolved).toContain('missing');
  });

  it('throws 400 when firing an inactive trigger (non-test)', async () => {
    const t = await createTenant(pool);
    const tr = await createTrigger(pool, KEY, { tenantId: t.id, label: 'Off', token: 'k', tokenPlacement: 'bearer', payloadTemplate: '{}' });
    await updateTrigger(pool, KEY, t.id, tr.id, { active: false });
    vi.stubGlobal('fetch', okFetch());
    await expect(fireTrigger(pool, KEY, { tenantId: t.id, triggerId: tr.id, vars: {}, source: 'manual' })).rejects.toThrow();
  });

  it('records ok=false on a network error', async () => {
    const t = await createTenant(pool);
    const tr = await createTrigger(pool, KEY, { tenantId: t.id, label: 'Net', token: 'k', tokenPlacement: 'bearer', payloadTemplate: '{}' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom'); }));
    const res = await fireTrigger(pool, KEY, { tenantId: t.id, triggerId: tr.id, vars: {}, source: 'test' });
    expect(res.ok).toBe(false);
    expect(res.httpStatus).toBeNull();
    expect(res.error).toContain('boom');
  });
});
