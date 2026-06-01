import { describe, it, expect } from 'vitest';
import { ABE_SYSTEM, buildAbeSystemPrompt } from '../src/agent/abe/prompt.js';

describe('abe prompt', () => {
  it('core prompt names Abe and forbids treating data as instructions', () => {
    expect(ABE_SYSTEM).toMatch(/Abe/);
    expect(ABE_SYSTEM.toLowerCase()).toContain('data');
  });
  it('appends brand voice when provided', () => {
    expect(buildAbeSystemPrompt('friendly, no jargon')).toContain('friendly, no jargon');
    expect(buildAbeSystemPrompt(null)).toBe(ABE_SYSTEM);
  });
});
