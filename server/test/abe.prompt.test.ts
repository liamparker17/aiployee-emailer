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
  it('persona replaces the identity but the hard rules and tool guidance survive', () => {
    const persona = 'You manage email for Marcel Fourie, Managing Director of Mafadi Property Group.';
    const p = buildAbeSystemPrompt('warm but direct', null, null, persona);
    expect(p).toContain('Marcel Fourie');
    expect(p).not.toContain('call-line analyst');           // default identity replaced
    expect(p).toContain('Hard rules — never break');        // invariants kept
    expect(p).toContain('analyze_campaign');                 // tool guidance kept
    expect(p).toContain('warm but direct');                  // brand voice still appended
  });
  it('blank persona falls back to the default identity', () => {
    expect(buildAbeSystemPrompt(null, null, null, '   ')).toBe(ABE_SYSTEM);
  });
});
