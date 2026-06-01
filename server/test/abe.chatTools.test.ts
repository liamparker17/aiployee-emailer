import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { upsertGoal, getGoal } from '../src/repos/agentGoals.js';
import { makeAbeChatProvider } from '../src/agent/abe/chatTools.js';

const pool = makePool();
const encKey = Buffer.alloc(32, 1);
const stubLlm = { chat: async () => ({ content: JSON.stringify({ touches: [{ subject: 's', body_html: '<p>b</p>' }] }), toolCalls: [] }) };
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('abe chat tools', () => {
  it('exposes read + safe-write tools and NO send tool', async () => {
    const p = makeAbeChatProvider({ pool, encKey, tenantId: 'x', baseUrl: 'http://x', llmFactory: () => stubLlm });
    const names = (await p.listTools()).map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['get_status', 'count_dormant', 'list_plays', 'get_play_outcomes', 'get_settings', 'update_settings', 'pause_abe', 'resume_abe', 'trigger_shift']));
    expect(names).not.toContain('send_play');
    expect(names.some(n => /send|execute/.test(n))).toBe(false);
  });

  it('update_settings clamps to server bounds and persists', async () => {
    const t = await createTenant(pool);
    await upsertGoal(pool, t.id, { enabled: true });
    const p = makeAbeChatProvider({ pool, encKey, tenantId: t.id, baseUrl: 'http://x', llmFactory: () => stubLlm });
    await p.callTool('update_settings', { maxTouches: 99, touchSpacingDays: 3 }); // 99 -> clamp 5
    const g = await getGoal(pool, t.id);
    expect(g?.max_touches).toBe(5);
    expect(g?.touch_spacing_days).toBe(3);
  });
});
