import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { insertApiKey } from '../src/repos/apiKeys.js';
import { generateApiKey, hashApiKey, prefixOf } from '../src/auth/apiKey.js';

const KEY = Buffer.alloc(32, 1);
const cfg = loadConfig({
  NODE_ENV: 'test', PORT: '0',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://emailer:emailer@localhost:5433/emailer',
  SESSION_SECRET: 'a'.repeat(32), EMAILER_ENC_KEY: KEY.toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000', CRON_SECRET: 'c'.repeat(24),
});

let app: Awaited<ReturnType<typeof buildApp>>;
const pool = makePool();
beforeAll(async () => { app = await buildApp({ cfg }); });
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await app.close(); await pool.end(); });

async function withKey() {
  const t = await createTenant(pool);
  const key = generateApiKey();
  await insertApiKey(pool, { tenantId: t.id, name: 'k', keyHash: hashApiKey(key), keyPrefix: prefixOf(key) });
  return { t, key };
}

const body = {
  company_key: 'V7E-...',
  customer_data: {
    main: { suid: 's1', name: 'Renier', phone: '+27', timezone: 'Africa/Johannesburg' },
    values: { type: 'Seller', call_summary: 'wants to sell', call_outcome: 'completed' },
  },
};

describe('POST /v1/jobix/calls', () => {
  it('401 without an API key', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/jobix/calls', payload: body });
    expect(r.statusCode).toBe(401);
  });

  it('ingests a call and is idempotent', async () => {
    const { t, key } = await withKey();
    const headers = { authorization: `Bearer ${key}` };

    const r1 = await app.inject({ method: 'POST', url: '/v1/jobix/calls', headers, payload: body });
    expect(r1.statusCode).toBe(202);
    expect(JSON.parse(r1.body).created).toBe(true);

    const r2 = await app.inject({ method: 'POST', url: '/v1/jobix/calls', headers, payload: body });
    expect(JSON.parse(r2.body).created).toBe(false);

    const cnt = await pool.query(`SELECT COUNT(*)::int AS n FROM agent_messages WHERE tenant_id=$1`, [t.id]);
    expect(cnt.rows[0].n).toBe(1);
    const f = await pool.query(`SELECT attribution_label, caller_suid FROM call_facts WHERE tenant_id=$1`, [t.id]);
    expect(f.rows[0].attribution_label).toBe('Seller');
    expect(f.rows[0].caller_suid).toBe('s1');
  });
});
