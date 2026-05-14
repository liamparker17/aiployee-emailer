import { describe, it, expect } from 'vitest';
import { generateApiKey, hashApiKey, prefixOf } from '../src/auth/apiKey.js';

describe('api key', () => {
  it('generates keys with aip_live_ prefix', () => {
    const k = generateApiKey();
    expect(k.startsWith('aip_live_')).toBe(true);
    expect(k.length).toBeGreaterThan(20);
  });
  it('hash is deterministic and not the plaintext', () => {
    const k = 'aip_live_abc123';
    const h = hashApiKey(k);
    expect(h).not.toBe(k);
    expect(h).toBe(hashApiKey(k));
  });
  it('prefix is first 13 chars', () => {
    expect(prefixOf('aip_live_abcdefgh')).toBe('aip_live_abcd');
  });
});
