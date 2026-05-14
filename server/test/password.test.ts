import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.js';

describe('password', () => {
  it('hashes and verifies', async () => {
    const h = await hashPassword('correct horse');
    expect(h).not.toBe('correct horse');
    expect(await verifyPassword('correct horse', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });
});
