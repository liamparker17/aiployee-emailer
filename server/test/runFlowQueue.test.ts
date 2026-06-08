import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createFlow, replaceSteps, activateFlow, enroll, listEnrollments, type StepKind } from '../src/repos/flows.js';
import { runFlowQueue } from '../src/flows/runFlowQueue.js';

const KEY = Buffer.alloc(32, 5);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

const okFire = () => vi.fn(async () => ({ ok: true, httpStatus: 200, responseSnippet: null, error: null, renderedPayload: '{}', unresolved: [] }));

async function activeFlow(tenantId: string, steps: Array<{ kind: StepKind; config: Record<string, unknown> }>) {
  const f = await createFlow(pool, { tenantId, name: 'F' });
  await replaceSteps(pool, tenantId, f.id, steps);
  await activateFlow(pool, tenantId, f.id);
  return f;
}

describe('runFlowQueue', () => {
  it('fires a call, parks at a wait, then completes after the wait elapses', async () => {
    const t = await createTenant(pool);
    const f = await activeFlow(t.id, [
      { kind: 'jobix_call', config: { triggerId: 'trig-1' } },
      { kind: 'wait', config: { days: 2 } },
      { kind: 'jobix_call', config: { triggerId: 'trig-1' } },
    ]);
    await enroll(pool, { tenantId: t.id, flowId: f.id, recipients: [{ name: 'Renier', phone: '+2760', context: { reason: 'unhappy' } }] });
    const fire = okFire();

    const s1 = await runFlowQueue(pool, KEY, { batchSize: 10, maxStepsPerTick: 50 }, fire);
    expect(s1.calls).toBe(1);
    expect(fire.mock.calls[0][2].triggerId).toBe('trig-1');
    expect(fire.mock.calls[0][2].vars).toMatchObject({ name: 'Renier', phone: '+2760', reason: 'unhappy' });
    let e = (await listEnrollments(pool, t.id, f.id, {})).enrollments[0];
    expect(e.status).toBe('active');
    expect(e.current_position).toBe(2);          // past the wait, parked before the final call
    expect(e.next_run_at).not.toBeNull();
    expect(new Date(e.next_run_at as unknown as string).getTime()).toBeGreaterThan(Date.now());

    // not due yet → nothing claimed
    const s2 = await runFlowQueue(pool, KEY, { batchSize: 10, maxStepsPerTick: 50 }, fire);
    expect(s2.claimed).toBe(0);

    // simulate the 2-day wait elapsing
    await pool.query(`UPDATE flow_enrollments SET next_run_at = now() - interval '1 minute' WHERE flow_id = $1`, [f.id]);
    const s3 = await runFlowQueue(pool, KEY, { batchSize: 10, maxStepsPerTick: 50 }, fire);
    expect(s3.calls).toBe(1);
    expect(s3.completed).toBe(1);
    e = (await listEnrollments(pool, t.id, f.id, {})).enrollments[0];
    expect(e.status).toBe('completed');
  });

  it('exits the enrollment when a condition fails (and does not fire)', async () => {
    const t = await createTenant(pool);
    const f = await activeFlow(t.id, [
      { kind: 'condition', config: { field: 'vip', op: 'exists', onFail: 'exit' } },
      { kind: 'jobix_call', config: { triggerId: 'trig-1' } },
    ]);
    await enroll(pool, { tenantId: t.id, flowId: f.id, recipients: [{ name: 'X', phone: '+2761' }] }); // no vip
    const fire = okFire();
    const s = await runFlowQueue(pool, KEY, { batchSize: 10, maxStepsPerTick: 50 }, fire);
    expect(s.exited).toBe(1);
    expect(fire).not.toHaveBeenCalled();
    expect((await listEnrollments(pool, t.id, f.id, {})).enrollments[0].status).toBe('exited');
  });

  it('ignores enrollments whose flow is not active', async () => {
    const t = await createTenant(pool);
    const f = await createFlow(pool, { tenantId: t.id, name: 'Draft' });
    await replaceSteps(pool, t.id, f.id, [{ kind: 'jobix_call', config: { triggerId: 'trig-1' } }]);
    await enroll(pool, { tenantId: t.id, flowId: f.id, recipients: [{ name: 'Y', phone: '+2762' }] }); // flow still draft
    const fire = okFire();
    const s = await runFlowQueue(pool, KEY, { batchSize: 10, maxStepsPerTick: 50 }, fire);
    expect(s.claimed).toBe(0);
    expect(fire).not.toHaveBeenCalled();
  });
});
