import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { upsertGoal } from '../src/repos/agentGoals.js';
import { listPlays } from '../src/repos/agentPlays.js';
import { encrypt } from '../src/crypto/enc.js';
import { runAbeShift } from '../src/agent/abe/shift.js';

const pool = makePool();
const encKey = Buffer.alloc(32, 1);

const stubLlm = {
  chat: async () => ({
    content: JSON.stringify({ touches: [{ subject: 'We miss you', body_html: '<p>hi</p>' }] }),
    toolCalls: [],
  }),
};
const stubFactory = () => stubLlm;

beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function seedAgentConfig(tenantId: string) {
  await pool.query(
    `INSERT INTO agent_configs (tenant_id, enabled, model, openai_key_encrypted)
     VALUES ($1, true, 'gpt-4.1', $2)`,
    [tenantId, encrypt('sk-test', encKey)],
  );
}
async function seedDormant(tenantId: string, email: string) {
  await pool.query(
    `INSERT INTO contacts (tenant_id, email, created_at) VALUES ($1, $2, now() - make_interval(days => 100))`,
    [tenantId, email],
  );
}

describe('runAbeShift', () => {
  it('creates a proposed play for a tenant with dormant contacts', async () => {
    const t = await createTenant(pool);
    await seedAgentConfig(t.id);
    await upsertGoal(pool, t.id, { enabled: true });
    await seedDormant(t.id, 'a@x.io');
    await seedDormant(t.id, 'b@x.io');

    const res = await runAbeShift({ pool, encKey, tenantId: t.id, llmFactory: stubFactory });
    expect(res.status).toBe('proposed');
    const plays = await listPlays(pool, t.id);
    expect(plays).toHaveLength(1);
    expect(plays[0].audience_snapshot.size).toBe(2);
    expect(plays[0].risk_score).toBe(2);
  });

  it('skips when there are no dormant contacts', async () => {
    const t = await createTenant(pool);
    await seedAgentConfig(t.id);
    await upsertGoal(pool, t.id, { enabled: true });
    const res = await runAbeShift({ pool, encKey, tenantId: t.id, llmFactory: stubFactory });
    expect(res.status).toBe('skipped');
    if (res.status === 'skipped') expect(res.reason).toBe('no_dormant_contacts');
  });

  it('skips when the tenant has no OpenAI key configured', async () => {
    const t = await createTenant(pool);
    await upsertGoal(pool, t.id, { enabled: true });
    await seedDormant(t.id, 'a@x.io');
    const res = await runAbeShift({ pool, encKey, tenantId: t.id, llmFactory: stubFactory });
    expect(res.status).toBe('skipped');
    if (res.status === 'skipped') expect(res.reason).toBe('no_openai_key');
  });
});
