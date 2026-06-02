import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { insertReport, listReports, getReport, setReportStatus } from '../src/repos/lineReports.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('lineReports repo', () => {
  it('inserts pending_approval and lists newest first', async () => {
    const t = await createTenant(pool);
    await insertReport(pool, { tenantId: t.id, reportType: 'digest', subject: 'S1', body: 'B1',
      metrics: { total: 3 }, sourceMessageIds: ['a'] });
    await insertReport(pool, { tenantId: t.id, reportType: 'alert', subject: 'S2', body: 'B2',
      metrics: {}, sourceMessageIds: [] });
    const all = await listReports(pool, t.id);
    expect(all).toHaveLength(2);
    expect(all[0].subject).toBe('S2');
    expect(all[0].status).toBe('pending_approval');
  });

  it('stores and returns the advisory payload', async () => {
    const t = await createTenant(pool);
    const adv = { diagnosis: 'd', root_cause_hypothesis: 'h', recommended_actions: [{ action: 'do x', owner: 'Team', urgency: 'high' as const }], draft_comms: { customer_message: 'cm', internal_note: 'in', talking_points: ['tp'] } };
    const r = await insertReport(pool, { tenantId: t.id, reportType: 'case', subject: 'S', body: 'B', metrics: {}, advisory: adv, sourceMessageIds: ['m1'] });
    const got = await getReport(pool, t.id, r.id);
    expect(got?.advisory.recommended_actions[0]).toMatchObject({ owner: 'Team', urgency: 'high' });
    expect(got?.advisory.draft_comms.talking_points).toContain('tp');
  });

  it('setReportStatus moves to sent with email + sent_at', async () => {
    const t = await createTenant(pool);
    const r = await insertReport(pool, { tenantId: t.id, reportType: 'digest', subject: 'S', body: 'B', metrics: {}, sourceMessageIds: [] });
    const sent = await setReportStatus(pool, t.id, r.id, 'sent', { emailId: '11111111-1111-1111-1111-111111111111' });
    expect(sent?.status).toBe('sent');
    expect(sent?.email_id).toBe('11111111-1111-1111-1111-111111111111');
    expect(sent?.sent_at).not.toBeNull();
  });
});
