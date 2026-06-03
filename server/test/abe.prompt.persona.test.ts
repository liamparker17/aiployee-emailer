import { describe, it, expect } from 'vitest';
import { ABE_SYSTEM, buildAbeSystemPrompt } from '../src/agent/abe/prompt.js';

it('Abe is the agentic call-line analyst, not a win-back marketer', () => {
  expect(ABE_SYSTEM.toLowerCase()).not.toContain('win back');
  expect(ABE_SYSTEM.toLowerCase()).not.toContain('returning customers');
  expect(ABE_SYSTEM).toContain('call-line analyst');
  expect(ABE_SYSTEM).toContain('never cold-contact');
  expect(buildAbeSystemPrompt('Warm and concise')).toContain('Warm and concise');
});
