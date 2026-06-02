import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { seedInboundCall } from './helpers/lineReport.js';
import { insertCallTag, listUntaggedInbound, aggregateByCategory, listHighSeverityUnreported } from '../src/repos/lineCallTags.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('lineCallTags repo', () => {
  it('tags once; re-insert for same message is a no-op', async () => {
    const t = await createTenant(pool);
    const m = await seedInboundCall(pool, t.id, 'Customer disputes a card charge');
    await insertCallTag(pool, { tenantId: t.id, messageId: m.id, category: 'Card disputes / fraud', severity: 'med', isEmerging: false });
    await insertCallTag(pool, { tenantId: t.id, messageId: m.id, category: 'Complaints', severity: 'low', isEmerging: false });
    const agg = await aggregateByCategory(pool, t.id, new Date(0), new Date(Date.now() + 1000));
    expect(agg.find(a => a.category === 'Card disputes / fraud')?.count).toBe(1);
    expect(agg.find(a => a.category === 'Complaints')).toBeUndefined();
  });

  it('listUntaggedInbound returns only untagged inbound messages', async () => {
    const t = await createTenant(pool);
    const m1 = await seedInboundCall(pool, t.id, 'app login failing');
    const m2 = await seedInboundCall(pool, t.id, 'debit order query');
    await insertCallTag(pool, { tenantId: t.id, messageId: m1.id, category: 'Online & app banking', severity: 'low', isEmerging: false });
    const untagged = await listUntaggedInbound(pool, t.id, 50);
    expect(untagged.map(r => r.id)).toEqual([m2.id]);
  });

  it('listHighSeverityUnreported returns high-severity tags not yet in a case report', async () => {
    const t = await createTenant(pool);
    const m = await seedInboundCall(pool, t.id, 'fraud on account');
    await insertCallTag(pool, { tenantId: t.id, messageId: m.id, category: 'Card disputes / fraud', severity: 'high', isEmerging: false });

    // Should appear before a case report references it
    const before = await listHighSeverityUnreported(pool, t.id, new Date(0));
    expect(before.map(r => r.message_id)).toContain(m.id);

    // Insert a line_reports row of type 'case' referencing this message
    await pool.query(
      `INSERT INTO line_reports (tenant_id, report_type, status, subject, body, source_message_ids)
       VALUES ($1, 'case', 'pending_approval', 'Case report', 'body text', $2::jsonb)`,
      [t.id, JSON.stringify([m.id])]);

    // Should now be excluded
    const after = await listHighSeverityUnreported(pool, t.id, new Date(0));
    expect(after.map(r => r.message_id)).not.toContain(m.id);
  });
});
