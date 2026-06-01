// server/test/abe.approvalToken.test.ts
import { describe, it, expect } from 'vitest';
import { signApprovalToken, verifyApprovalToken, hashToken } from '../src/agent/abe/approvalToken.js';

const KEY = Buffer.alloc(32, 7);

describe('approvalToken', () => {
  it('round-trips id + expiry', () => {
    const exp = Date.now() + 60_000;
    const tok = signApprovalToken('play-123', exp, KEY);
    const got = verifyApprovalToken(tok, KEY);
    expect(got).toEqual({ id: 'play-123', expiresMs: exp });
  });

  it('rejects a tampered signature', () => {
    const tok = signApprovalToken('play-123', Date.now() + 60_000, KEY);
    const tampered = tok.slice(0, -1) + (tok.endsWith('a') ? 'b' : 'a');
    expect(verifyApprovalToken(tampered, KEY)).toBeNull();
  });

  it('rejects a token signed with a different key', () => {
    const tok = signApprovalToken('play-123', Date.now() + 60_000, KEY);
    expect(verifyApprovalToken(tok, Buffer.alloc(32, 9))).toBeNull();
  });

  it('rejects an expired token', () => {
    const tok = signApprovalToken('play-123', Date.now() - 1, KEY);
    expect(verifyApprovalToken(tok, KEY)).toBeNull();
  });

  it('rejects a malformed token', () => {
    expect(verifyApprovalToken('nonsense', KEY)).toBeNull();
    expect(verifyApprovalToken('a.b', KEY)).toBeNull();
  });

  it('hashToken is deterministic 64-char hex and differs per token', () => {
    const tok = signApprovalToken('play-123', Date.now() + 60_000, KEY);
    const h = hashToken(tok);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(tok)).toBe(h);
    expect(hashToken(tok + 'x')).not.toBe(h);
  });
});
