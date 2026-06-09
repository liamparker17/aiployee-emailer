import { describe, it, expect } from 'vitest';
import { issueHandoffToken, verifyHandoffToken } from '@aiployee/core';

const secret = 'test-secret-please-change';

describe('handoff token', () => {
  it('round-trips a valid token', () => {
    const tok = issueHandoffToken({ userId: 'u1', tenantId: 't1' }, secret, 60);
    const out = verifyHandoffToken(tok, secret);
    expect(out.userId).toBe('u1');
    expect(out.tenantId).toBe('t1');
    expect(out.jti).toBeTruthy();
  });

  it('carries a null tenantId (super admin)', () => {
    const tok = issueHandoffToken({ userId: 'u1', tenantId: null }, secret, 60);
    expect(verifyHandoffToken(tok, secret).tenantId).toBeNull();
  });

  it('rejects a tampered token', () => {
    const tok = issueHandoffToken({ userId: 'u1', tenantId: 't1' }, secret, 60);
    expect(() => verifyHandoffToken(tok.slice(0, -2) + 'xx', secret)).toThrow();
  });

  it('rejects an expired token', () => {
    const tok = issueHandoffToken({ userId: 'u1', tenantId: 't1' }, secret, -1);
    expect(() => verifyHandoffToken(tok, secret)).toThrow(/expired/);
  });

  it('rejects a token signed with a different secret', () => {
    const tok = issueHandoffToken({ userId: 'u1', tenantId: 't1' }, secret, 60);
    expect(() => verifyHandoffToken(tok, 'other-secret')).toThrow(/signature/);
  });

  it('issues unique jti per token (replay guard basis)', () => {
    const a = verifyHandoffToken(issueHandoffToken({ userId: 'u', tenantId: 't' }, secret), secret);
    const b = verifyHandoffToken(issueHandoffToken({ userId: 'u', tenantId: 't' }, secret), secret);
    expect(a.jti).not.toBe(b.jti);
  });
});
