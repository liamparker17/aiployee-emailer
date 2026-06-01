import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { insertChatMessage, listChatMessages } from '../src/repos/agentChat.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('agentChat repo', () => {
  it('inserts and lists messages chronologically', async () => {
    const t = await createTenant(pool);
    await insertChatMessage(pool, t.id, 'user', 'hi');
    await insertChatMessage(pool, t.id, 'abe', 'hello, I am Abe');
    const msgs = await listChatMessages(pool, t.id);
    expect(msgs.map(m => m.role)).toEqual(['user', 'abe']);
    expect(msgs[1].content).toBe('hello, I am Abe');
  });
});
