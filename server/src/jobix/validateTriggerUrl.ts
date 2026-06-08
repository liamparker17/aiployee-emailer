import { AppError } from '@aiployee/core';

const PRIVATE_HOST = /^(0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.)/;

export function validateTriggerUrl(raw: string): void {
  let u: URL;
  try { u = new URL(raw); } catch { throw new AppError('invalid_url', 400, 'Invalid URL'); }
  if (u.protocol !== 'https:') throw new AppError('invalid_url', 400, 'URL must use https');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '::1' || PRIVATE_HOST.test(host)) {
    throw new AppError('invalid_url', 400, 'URL host is not allowed');
  }
}
