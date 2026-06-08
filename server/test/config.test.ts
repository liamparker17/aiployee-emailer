import { describe, it, expect } from 'vitest';
import { loadConfig } from '@aiployee/core';

describe('loadConfig', () => {
  it('parses required env', () => {
    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3000',
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      SESSION_SECRET: 'a'.repeat(32),
      EMAILER_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
      PUBLIC_BASE_URL: 'http://localhost:3000',
      CRON_SECRET: 'c'.repeat(24),
    });
    expect(cfg.port).toBe(3000);
    expect(cfg.encKey).toHaveLength(32);
  });

  it('rejects too-short SESSION_SECRET', () => {
    expect(() => loadConfig({
      DATABASE_URL: 'postgres://x',
      SESSION_SECRET: 'short',
      EMAILER_ENC_KEY: Buffer.alloc(32).toString('base64'),
      PUBLIC_BASE_URL: 'http://x',
    })).toThrow();
  });
});
