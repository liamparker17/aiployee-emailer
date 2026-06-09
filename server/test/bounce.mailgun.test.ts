import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyMailgun, parseMailgunEvent } from '../src/webhooks/mailgun.js';
import { loadConfig } from '@aiployee/core';

const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
  CRON_SECRET: 'c'.repeat(24),
});

beforeEach(() => { process.env.MAILGUN_SIGNING_KEY = 'test-signing-key'; });
afterEach(() => { delete process.env.MAILGUN_SIGNING_KEY; });

function sign(timestamp: string, token: string): string {
  return createHmac('sha256', 'test-signing-key').update(timestamp + token).digest('hex');
}

describe('verifyMailgun', () => {
  it('accepts a valid signature within window', () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const token = 'tok';
    const signature = sign(ts, token);
    expect(() => verifyMailgun({ signature: { timestamp: ts, token, signature } }, cfg)).not.toThrow();
  });

  it('rejects bad signature', () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    expect(() => verifyMailgun({ signature: { timestamp: ts, token: 't', signature: 'bad' } }, cfg))
      .toThrow();
  });

  it('rejects expired timestamp', () => {
    const ts = (Math.floor(Date.now() / 1000) - 600).toString();
    const token = 'tok';
    const signature = sign(ts, token);
    expect(() => verifyMailgun({ signature: { timestamp: ts, token, signature } }, cfg))
      .toThrow(/expired/);
  });
});

describe('parseMailgunEvent', () => {
  it('parses permanent failed as bounce', () => {
    const ev = parseMailgunEvent({
      'event-data': {
        event: 'failed', severity: 'permanent', recipient: 'r@x.com',
        message: { headers: { 'message-id': '<abc>' } },
      },
    });
    expect(ev).toEqual({ type: 'bounce', messageId: 'abc', recipient: 'r@x.com' });
  });

  it('parses complained', () => {
    const ev = parseMailgunEvent({
      'event-data': {
        event: 'complained', recipient: 'r@x.com',
        message: { headers: { 'message-id': '<abc>' } },
      },
    });
    expect(ev).toEqual({ type: 'complaint', messageId: 'abc', recipient: 'r@x.com' });
  });

  it('returns null for missing message id', () => {
    const ev = parseMailgunEvent({
      'event-data': { event: 'failed', severity: 'permanent', recipient: 'r@x.com' },
    });
    expect(ev).toBeNull();
  });
});
