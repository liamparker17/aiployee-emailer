import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { upsertGoal } from '../src/repos/agentGoals.js';
import { listChatMessages } from '../src/repos/agentChat.js';
import { encrypt } from '../src/crypto/enc.js';
import { runAbeChat } from '../src/agent/abe/chat.js';

const pool = makePool();
const encKey = Buffer.alloc(32, 1);
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

// First chat() returns a tool call to count_dormant; second returns final text.
function scriptedLlm() {
  let n = 0;
  return () => ({ chat: async () => (n++ === 0
    ? { content: '', toolCalls: [{ id: 't1', name: 'count_dormant', arguments: '{}' }] }
    : { content: 'You have 0 dormant contacts right now.', toolCalls: [] }) });
}
async function seedConfig(tenantId: string) {
  await pool.query(`INSERT INTO agent_configs (tenant_id, enabled, model, openai_key_encrypted) VALUES ($1,true,'gpt-4.1',$2)`,
    [tenantId, encrypt('sk-test', encKey)]);
}

describe('runAbeChat', () => {
  it('runs the tool loop, persists user + abe messages, returns the reply', async () => {
    const t = await createTenant(pool);
    await seedConfig(t.id); await upsertGoal(pool, t.id, { enabled: true });
    const res = await runAbeChat({ pool, encKey, tenantId: t.id, baseUrl: 'http://x', userMessage: 'how many are dormant?', llmFactory: scriptedLlm() });
    expect(res.reply).toContain('dormant');
    const msgs = await listChatMessages(pool, t.id);
    expect(msgs.map(m => m.role)).toEqual(['user', 'abe']);
  });

  it('returns guidance (no crash) when no OpenAI key is configured', async () => {
    const t = await createTenant(pool); await upsertGoal(pool, t.id, { enabled: true });
    const res = await runAbeChat({ pool, encKey, tenantId: t.id, baseUrl: 'http://x', userMessage: 'hi', llmFactory: scriptedLlm() });
    expect(res.reply.toLowerCase()).toContain('openai');
    const msgs = await listChatMessages(pool, t.id);
    expect(msgs.map(m => m.role)).toEqual(['user', 'abe']); // both persisted
  });
});
