import { describe, it, expect } from 'vitest';
import { draftReengagePlay } from '../src/agent/abe/draftPlay.js';

const stubLlm = {
  chat: async () => ({
    content: JSON.stringify({
      touches: [
        { subject: 'We miss you', body_html: '<p>Come back</p>' },
        { subject: 'Still here', body_html: '<p>Anything we can help with?</p>' },
      ],
    }),
    toolCalls: [],
  }),
};

describe('draftReengagePlay', () => {
  it('builds spaced touches capped at maxTouches with indices and offsets', async () => {
    const touches = await draftReengagePlay({
      llm: stubLlm, model: 'gpt-4.1', brandVoice: null,
      maxTouches: 3, touchSpacingDays: 3, audienceSize: 40,
    });
    expect(touches).toHaveLength(2);
    expect(touches[0]).toMatchObject({ index: 0, scheduled_offset_days: 0, subject: 'We miss you' });
    expect(touches[1]).toMatchObject({ index: 1, scheduled_offset_days: 3 });
  });

  it('throws on unparseable LLM output (caller treats tenant as skipped)', async () => {
    const bad = { chat: async () => ({ content: 'not json', toolCalls: [] }) };
    await expect(draftReengagePlay({
      llm: bad, model: 'gpt-4.1', brandVoice: null, maxTouches: 3, touchSpacingDays: 3, audienceSize: 40,
    })).rejects.toThrow();
  });
});
