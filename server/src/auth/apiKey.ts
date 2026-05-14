import { randomBytes, createHash } from 'node:crypto';

export function generateApiKey(): string {
  return 'aip_live_' + randomBytes(24).toString('base64url');
}
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
export function prefixOf(key: string): string {
  return key.slice(0, 13);
}
