import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { seedInboundCall } from './helpers/lineReport.js';
import {
  insertHandover, listHandovers, getHandover, setHandoverStatus,
  listUnextractedInbound, findRecentByCaller,
} from '../src/repos/callHandovers.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('callHandovers repo', () => {
  it('inserts once per message; lists pending; sets status', async () => {
    const t = await createTenant(pool);
    const m = await seedInboundCall(pool, t.id, 'debit dispute');
    const h = await insertHandover(pool, { tenantId: t.id, messageId: m.id, callerName: 'Thandi', callerPhone: '0820000000', reasonCategory: 'Debit orders', summary: 's', recommendedAction: 'call back', urgency: 'high', vulnerable: true, missingFields: [] });
    await insertHandover(pool, { tenantId: t.id, messageId: m.id, reasonCategory: 'Complaints', summary: 'x', recommendedAction: '', urgency: 'low', vulnerable: false, missingFields: [] });
    const pending = await listHandovers(pool, t.id, 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].caller_name).toBe('Thandi');
    const fwd = await setHandoverStatus(pool, t.id, h.id, 'forwarded', { emailId: '11111111-1111-1111-1111-111111111111' });
    expect(fwd?.status).toBe('forwarded');
    expect(fwd?.forwarded_at).not.toBeNull();
  });

  it('listUnextractedInbound excludes calls that already have a handover', async () => {
    const t = await createTenant(pool);
    const m1 = await seedInboundCall(pool, t.id, 'a');
    const m2 = await seedInboundCall(pool, t.id, 'b');
    await insertHandover(pool, { tenantId: t.id, messageId: m1.id, reasonCategory: 'X', summary: '', recommendedAction: '', urgency: 'med', vulnerable: false, missingFields: [] });
    const todo = await listUnextractedInbound(pool, t.id, 50);
    expect(todo.map(r => r.id)).toEqual([m2.id]);
  });

  it('findRecentByCaller matches a prior handover by phone within the window', async () => {
    const t = await createTenant(pool);
    const m1 = await seedInboundCall(pool, t.id, 'first');
    const first = await insertHandover(pool, { tenantId: t.id, messageId: m1.id, callerPhone: '0825551234', reasonCategory: 'X', summary: '', recommendedAction: '', urgency: 'med', vulnerable: false, missingFields: [] });
    const hit = await findRecentByCaller(pool, t.id, '0825551234', null, 7);
    expect(hit?.id).toBe(first.id);
    expect(await findRecentByCaller(pool, t.id, '0829999999', null, 7)).toBeNull();
  });
});
