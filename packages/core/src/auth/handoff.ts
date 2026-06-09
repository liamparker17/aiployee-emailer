// Cross-app SSO: a short-lived, single-use HMAC token that lets a logged-in user move
// between the email app and the command-centre app (different *.vercel.app origins, which
// cannot share a cookie) without re-authenticating. Both apps run the same backend and share
// SESSION_SECRET + the users table, so the receiving side verifies and mints its own session.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export interface HandoffClaims {
  userId: string;
  tenantId: string | null;
}

export interface HandoffPayload extends HandoffClaims {
  exp: number; // unix seconds
  jti: string; // single-use id (replay guard)
}

const b64url = (b: Buffer) => b.toString('base64url');

function sign(body: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(body).digest());
}

export function issueHandoffToken(claims: HandoffClaims, secret: string, ttlSeconds = 60): string {
  const payload: HandoffPayload = {
    userId: claims.userId,
    tenantId: claims.tenantId ?? null,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    jti: randomUUID(),
  };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${sign(body, secret)}`;
}

export function verifyHandoffToken(token: string, secret: string): HandoffPayload {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('malformed handoff token');
  const [body, mac] = parts;
  const expected = sign(body, secret);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('bad handoff signature');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as HandoffPayload;
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('expired handoff token');
  }
  if (!payload.jti || !payload.userId) throw new Error('invalid handoff token');
  return payload;
}
