import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig({
  NODE_ENV: 'test',
  PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
  CRON_SECRET: 'c'.repeat(24),
});
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => { app = await buildApp({ cfg }); });
afterAll(async () => { await app.close(); });

describe('healthz', () => {
  it('responds 200 ok:true', async () => {
    const r = await app.inject({ method: 'GET', url: '/healthz' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });
});
