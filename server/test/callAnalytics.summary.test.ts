import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { callAnalyticsSummary } from '../src/repos/callAnalytics.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function seed(tenantId: string, f: { resolution?: string; fcr?: boolean; callback?: boolean; escalation?: boolean; sentiment?: string; duration?: number }) {
  const th = await pool.query<{ id: string }>(`INSERT INTO agent_threads (tenant_id, jobix_thread_ref) VALUES ($1,'jobix:'||gen_random_uuid()) RETURNING id`, [tenantId]);
  const m = await pool.query<{ id: string }>(`INSERT INTO agent_messages (thread_id, tenant_id, role, source, content, status) VALUES ($1,$2,'inbound','jobix','x','sent') RETURNING id`, [th.rows[0].id, tenantId]);
  await pool.query(`INSERT INTO call_facts (tenant_id, message_id, resolution_state, fcr, callback_requested, escalation_requested, sentiment, call_duration_seconds)
    VALUES ($1,$2,COALESCE($3,'open'),$4,$5,$6,$7,$8)`,
    [tenantId, m.rows[0].id, f.resolution ?? null, f.fcr ?? null, f.callback ?? false, f.escalation ?? false, f.sentiment ?? null, f.duration ?? null]);
}

describe('callAnalyticsSummary', () => {
  it('computes totals, resolution rate, fcr, callback, escalation, avg duration, sentiment mix', async () => {
    const t = await createTenant(pool);
    await seed(t.id, { resolution: 'resolved', fcr: true, sentiment: 'positive', duration: 120 });
    await seed(t.id, { resolution: 'open', callback: true, sentiment: 'negative', duration: 60 });
    await seed(t.id, { resolution: 'resolved', escalation: true, sentiment: null, duration: null });
    const s = await callAnalyticsSummary(pool, t.id, new Date('2000-01-01'), new Date('2999-01-01'));
    expect(s.total).toBe(3);
    expect(s.resolved).toBe(2);
    expect(s.resolutionRatePct).toBe(67);
    expect(s.fcrCount).toBe(1);
    expect(s.callbackCount).toBe(1);
    expect(s.escalationCount).toBe(1);
    expect(s.avgDurationSeconds).toBe(90);
    expect(s.sentimentMix).toEqual({ positive: 1, neutral: 0, negative: 1, unknown: 1 });
  });
});
