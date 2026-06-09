// server/test/abe.publicAuth.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '@aiployee/core';
import { makePool } from './helpers/db.js';

const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
  CRON_SECRET: 'c'.repeat(24),
});

let app: Awaited<ReturnType<typeof buildApp>>;
const pool = makePool();
beforeAll(async () => { app = await buildApp({ cfg }); });
afterAll(async () => { await app.close(); await pool.end(); });

describe('public /v1/agent/ auth exclusion', () => {
  it('does not require an API key (no 401) for a /v1/agent/ path', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/agent/verify-manager/bad.token' });
    expect(r.statusCode).not.toBe(401);
  });
});
