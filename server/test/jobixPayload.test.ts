import { describe, it, expect } from 'vitest';
import { parseDurationSeconds } from '../src/agent/abe/jobixPayload.js';

describe('parseDurationSeconds', () => {
  it('parses "3 minutes 42 seconds" to 222', () => {
    expect(parseDurationSeconds('3 minutes 42 seconds')).toBe(222);
  });
  it('parses minutes-only and seconds-only', () => {
    expect(parseDurationSeconds('5 minutes')).toBe(300);
    expect(parseDurationSeconds('45 seconds')).toBe(45);
  });
  it('returns null for missing/garbage', () => {
    expect(parseDurationSeconds(undefined)).toBeNull();
    expect(parseDurationSeconds('')).toBeNull();
    expect(parseDurationSeconds('soon')).toBeNull();
  });
});
