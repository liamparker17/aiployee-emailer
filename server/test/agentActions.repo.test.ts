// server/test/agentActions.repo.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant, createUser } from './helpers/factories.js';
import {
  createAction, getAction, listActions, approveAction, rejectAction,
  editActionDraft, assignAction, snoozeAction, markActionExecuted,
} from '../src/repos/agentActions.js';

const pool = makePool();
afterAll(async () => { await pool.end(); });
beforeEach(async () => { await truncateAll(pool); });

async function anAction(tenantId: string) {
  return createAction(pool, {
    tenantId, threadId: null, campaignId: null, contactId: null, actionType: 'send_reply',
    title: 'Reply with pricing', draftSubject: 'Re: Pricing', draftBody: '<p>Here is our pricing</p>',
    reason: 'They asked for a quote', confidence: 0.9, riskLevel: 'medium', sourceRefs: { inbound_email_id: 'x' },
  });
}

describe('agentActions repo', () => {
  it('creates a pending action with defaults', async () => {
    const t = await createTenant(pool);
    const a = await anAction(t.id);
    expect(a.status).toBe('pending');
    expect(a.recommended_by).toBe('abe');
    expect(a.action_type).toBe('send_reply');
    expect((a.source_refs as Record<string, unknown>).inbound_email_id).toBe('x');
  });

  it('lists pending actions tenant-scoped', async () => {
    const t1 = await createTenant(pool);
    const t2 = await createTenant(pool);
    await anAction(t1.id);
    await anAction(t2.id);
    const list = await listActions(pool, t1.id, { status: 'pending' });
    expect(list).toHaveLength(1);
  });

  it('approve / reject / edit / assign / snooze / execute transition state', async () => {
    const t = await createTenant(pool);
    const u = await createUser(pool, { tenantId: t.id, email: 'admin@x.com', role: 'tenant_admin' });

    const a1 = await anAction(t.id);
    await editActionDraft(pool, t.id, a1.id, { subject: 'Re: Edited', body: '<p>edited</p>' });
    const edited = await getAction(pool, t.id, a1.id);
    expect((edited?.edited_payload as Record<string, unknown>).subject).toBe('Re: Edited');
    expect(edited?.status).toBe('pending');

    await approveAction(pool, t.id, a1.id, u.id);
    expect((await getAction(pool, t.id, a1.id))?.status).toBe('approved');
    await markActionExecuted(pool, t.id, a1.id);
    const done = await getAction(pool, t.id, a1.id);
    expect(done?.status).toBe('executed');
    expect(done?.executed_at).not.toBeNull();

    const a2 = await anAction(t.id);
    await rejectAction(pool, t.id, a2.id, u.id);
    expect((await getAction(pool, t.id, a2.id))?.status).toBe('rejected');

    const a3 = await anAction(t.id);
    await assignAction(pool, t.id, a3.id, u.id);
    expect((await getAction(pool, t.id, a3.id))?.assigned_to_user_id).toBe(u.id);

    const a4 = await anAction(t.id);
    await snoozeAction(pool, t.id, a4.id, new Date('2026-07-01T09:00:00Z'));
    const snoozed = await getAction(pool, t.id, a4.id);
    expect(snoozed?.status).toBe('snoozed');
    expect(snoozed?.snoozed_until).not.toBeNull();
  });
});
