import { describe, it, expect } from 'vitest';
import { scoreRisk, requiresApproval } from '../src/agent/abe/risk.js';

describe('abe risk', () => {
  it('risk score equals audience size for v1', () => {
    expect(scoreRisk({ audienceSize: 250 })).toBe(250);
  });
  it('requiresApproval when audience exceeds auto-fire cap (default cap 0 => always)', () => {
    expect(requiresApproval(1, 0)).toBe(true);
    expect(requiresApproval(50, 100)).toBe(false);
    expect(requiresApproval(150, 100)).toBe(true);
  });
});
