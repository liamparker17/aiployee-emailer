import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { buildApp } from '../src/app.js';

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); });

describe('healthz', () => {
  it('responds 200 ok:true', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
