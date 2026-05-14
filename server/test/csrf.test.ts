import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32),
  EMAILER_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
});
let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  app = await buildApp({ cfg });
  app.post('/echo', async (req) => ({ ok: true }));
});
afterAll(async () => { await app.close(); });

describe('csrf', () => {
  it('rejects POST without csrf token', async () => {
    const r = await app.inject({ method: 'POST', url: '/echo' });
    expect(r.statusCode).toBe(403);
  });
  it('accepts POST when X-CSRF-Token matches cookie', async () => {
    const get = await app.inject({ method: 'GET', url: '/healthz' });
    const setCookie = get.headers['set-cookie'] as string | string[];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const sidCookie = cookies.find(c => c.startsWith('aip_sid='))!;
    const csrfCookie = cookies.find(c => c.startsWith('aip_csrf='))!;
    const csrfVal = decodeURIComponent(csrfCookie.split(';')[0].split('=')[1]);
    const r = await app.inject({
      method: 'POST', url: '/echo',
      headers: { cookie: `${sidCookie.split(';')[0]}; ${csrfCookie.split(';')[0]}`, 'x-csrf-token': csrfVal },
    });
    expect(r.statusCode).toBe(200);
  });
});
