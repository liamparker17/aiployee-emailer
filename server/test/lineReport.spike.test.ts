import { describe, it, expect } from 'vitest';
import { detectSpikes } from '../src/agent/abe/lineSpike.js';

it('flags a category >= +50% over baseline with >= min count', () => {
  const spikes = detectSpikes({
    current: [{ category: 'Card disputes / fraud', count: 12 }, { category: 'Debit orders', count: 4 }],
    baselineAvg: { 'Card disputes / fraud': 6, 'Debit orders': 3 },
    spikePct: 50, spikeMinCount: 5,
  });
  expect(spikes).toHaveLength(1);
  expect(spikes[0]).toMatchObject({ category: 'Card disputes / fraud', count: 12, baseline: 6 });
});

it('does not flag below min count even if % is high', () => {
  const spikes = detectSpikes({
    current: [{ category: 'Fees & charges', count: 3 }],
    baselineAvg: { 'Fees & charges': 0.5 }, spikePct: 50, spikeMinCount: 5,
  });
  expect(spikes).toHaveLength(0);
});

it('flags a brand-new category (no baseline) once it clears min count', () => {
  const spikes = detectSpikes({
    current: [{ category: 'Complaints', count: 8 }],
    baselineAvg: {}, spikePct: 50, spikeMinCount: 5,
  });
  expect(spikes).toHaveLength(1);
  expect(spikes[0]).toMatchObject({ category: 'Complaints', count: 8, baseline: 0, pctOver: 100 });
});
