import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

// HMAC over a payload string, identical construction to marketing/unsubscribe.ts `sig()`.
function sig(payload: string, key: Buffer): string {
  return createHmac('sha256', key).update(payload).digest('base64url').slice(0, 24);
}

/**
 * Signed, expiring token: `${id}.${expiresMs}.${sig(id.expiresMs)}`.
 * `id` is the playId (approval) or tenantId (verify-manager); `expiresMs` is an
 * absolute epoch-ms deadline. The verifier rejects expired tokens.
 */
export function signApprovalToken(id: string, expiresMs: number, key: Buffer): string {
  const payload = `${id}.${expiresMs}`;
  return `${payload}.${sig(payload, key)}`;
}

export function verifyApprovalToken(token: string, key: Buffer): { id: string; expiresMs: number } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [id, expiresStr, given] = parts;
  const expiresMs = Number(expiresStr);
  if (!Number.isFinite(expiresMs)) return null;
  const expected = sig(`${id}.${expiresStr}`, key);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Date.now() > expiresMs) return null;
  return { id, expiresMs };
}

// sha256 hex of the full token, stored in agent_approvals.token_hash for single-use checks.
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Constant-time comparison of two token hashes (sha256 hex). Both are fixed 64-char hex.
export function tokenHashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
