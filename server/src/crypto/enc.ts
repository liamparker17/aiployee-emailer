import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const IV_LEN = 12;
const TAG_LEN = 16;

export function encrypt(plaintext: string, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error('key must be 32 bytes');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

export function decrypt(blob: Buffer, key: Buffer): string {
  if (key.length !== 32) throw new Error('key must be 32 bytes');
  if (blob.length < IV_LEN + TAG_LEN) throw new Error('ciphertext too short');
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const dec = createDecipheriv('aes-256-gcm', key, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
}
