import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../src/crypto/enc.js';

const KEY = Buffer.alloc(32, 7);

describe('AES-256-GCM', () => {
  it('round-trips plaintext', () => {
    const ct = encrypt('hello world', KEY);
    expect(ct).toBeInstanceOf(Buffer);
    expect(decrypt(ct, KEY)).toBe('hello world');
  });
  it('rejects tampered ciphertext', () => {
    const ct = encrypt('secret', KEY);
    ct[ct.length - 1] ^= 0x01;
    expect(() => decrypt(ct, KEY)).toThrow();
  });
  it('produces different ciphertext each call (random IV)', () => {
    expect(encrypt('same', KEY).equals(encrypt('same', KEY))).toBe(false);
  });
});
