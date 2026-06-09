import { createHmac, timingSafeEqual } from 'node:crypto';

// Self-contained, signed unsubscribe token: `${tenantId}.${contactId}.${sig}`.
// No DB column needed — the token identifies the contact and is HMAC-verified.
function sig(payload: string, key: Buffer): string {
  return createHmac('sha256', key).update(payload).digest('base64url').slice(0, 24);
}

export function signUnsubToken(tenantId: string, contactId: string, key: Buffer): string {
  const payload = `${tenantId}.${contactId}`;
  return `${payload}.${sig(payload, key)}`;
}

export function verifyUnsubToken(token: string, key: Buffer): { tenantId: string; contactId: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [tenantId, contactId, given] = parts;
  const expected = sig(`${tenantId}.${contactId}`, key);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { tenantId, contactId };
}
