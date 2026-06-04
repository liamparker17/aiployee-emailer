import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { upsertGoal } from '../src/repos/agentGoals.js';
import { listPlays } from '../src/repos/agentPlays.js';
import { encrypt } from '../src/crypto/enc.js';
import { runAbeChat } from '../src/agent/abe/chat.js';
import type { LlmClient, LlmFactory } from '../src/agent/runner.js';

const pool = makePool();
const encKey = Buffer.alloc(32, 1);
beforeEach(async () => { await truncateAll(pool); }, 30000);
afterAll(async () => { await pool.end(); });

/**
 * Scripted LLM factory for the safety test.
 *
 * Each factory call returns a fresh LlmClient. We distinguish contexts by
 * whether the call includes tools:
 *   - With tools   → chat tool-loop: turn 0 calls trigger_shift; turn 1 gives the final reply.
 *   - Without tools → draftReengagePlay: return valid JSON touches so the shift can proceed.
 *
 * Using a shared counter per factory instance, not per client, so that the
 * two clients produced (one for the chat loop, one inside runAbeShift) each
 * have independent state.
 */
function makeScriptedFactory(): LlmFactory {
  return (_apiKey: string): LlmClient => {
    let callCount = 0;
    return {
      async chat({ tools }) {
        const n = callCount++;
        // draftReengagePlay calls chat WITHOUT tools → return valid touches JSON
        if (!tools || tools.length === 0) {
          return {
            content: JSON.stringify({ touches: [{ subject: 'Win-back', body_html: '<p>We miss you!</p>' }] }),
            toolCalls: [],
          };
        }
        // Chat tool-loop calls WITH tools:
        //   first turn  → trigger_shift tool call
        //   second turn → final text reply
        if (n === 0) {
          return {
            content: '',
            toolCalls: [{ id: 'c1', name: 'trigger_shift', arguments: '{}' }],
          };
        }
        return {
          content: "I've queued a re-engagement play for your approval.",
          toolCalls: [],
        };
      },
    };
  };
}

describe('chat safety: trigger_shift cannot send email to contacts', () => {
  it(
    'produces no sent emails and leaves play in pending_approval after the strongest tool call',
    async () => {
      // --- seed -----------------------------------------------------------
      const t = await createTenant(pool);

      // agent_configs row with an encrypted key (so chat proceeds past the "no key" guard)
      await pool.query(
        `INSERT INTO agent_configs (tenant_id, enabled, model, openai_key_encrypted)
         VALUES ($1, true, 'gpt-4.1', $2)`,
        [t.id, encrypt('sk-test', encKey)],
      );

      // enabled goal; auto_fire_max_audience defaults to 0 → everything needs approval
      await upsertGoal(pool, t.id, { enabled: true });

      // 2 dormant contacts created ~100 days ago (well beyond the default 60-day window).
      // findDormantContacts requires created_at < now() - windowDays (default 60).
      await pool.query(
        `INSERT INTO contacts (tenant_id, email, name, created_at)
         VALUES
           ($1, 'dormant1@example.com', 'Alice Old', now() - interval '100 days'),
           ($1, 'dormant2@example.com', 'Bob Old',   now() - interval '100 days')`,
        [t.id],
      );

      // --- act ------------------------------------------------------------
      const res = await runAbeChat({
        pool,
        encKey,
        tenantId: t.id,
        baseUrl: 'http://x',
        userMessage: 'blast everyone right now',
        llmFactory: makeScriptedFactory(),
      });

      // --- assert: no emails sent -----------------------------------------
      const { rows } = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM emails WHERE tenant_id = $1 AND status = 'sent'`,
        [t.id],
      );
      expect(rows[0].count, 'emails sent must be zero — chat has no send path').toBe(0);

      // --- assert: play is pending_approval, never executing/done ----------
      const plays = await listPlays(pool, t.id);
      expect(plays.length, 'trigger_shift must have created a play').toBeGreaterThan(0);
      const statuses = plays.map(p => p.status);
      expect(
        statuses.some(s => s === 'pending_approval' || s === 'proposed'),
        `play must be pending_approval or proposed; got: ${statuses.join(', ')}`,
      ).toBe(true);
      expect(
        statuses.some(s => s === 'executing' || s === 'done'),
        `play must NOT be executing or done; got: ${statuses.join(', ')}`,
      ).toBe(false);

      // chat should have produced a reply
      expect(res.reply).toBeTruthy();
    },
    30000,
  );

  it('tool list for chat has no send/execute tool', async () => {
    const { makeAbeChatProvider } = await import('../src/agent/abe/chatTools.js');
    const stubLlm: LlmClient = {
      chat: async () => ({ content: '{}', toolCalls: [] }),
    };
    const p = makeAbeChatProvider({
      pool,
      encKey,
      tenantId: 'x',
      baseUrl: 'http://x',
      llmFactory: () => stubLlm,
    });
    const names = (await p.listTools()).map((tool) => tool.name);
    expect(names.some((n) => /send|execute/.test(n))).toBe(false);
    expect(names).not.toContain('send_play');
    expect(names).not.toContain('execute_play');
  });
});
