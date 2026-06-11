import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '@aiployee/core';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant, createUser } from './helpers/factories.js';
import { csrfFor, login } from './helpers/auth.js';
import { createFlow, replaceSteps, activateFlow, enroll, listEnrollments, type StepKind } from '../src/repos/flows.js';
import { runFlowQueue, type WaSendFn } from '../src/flows/runFlowQueue.js';

const KEY = Buffer.alloc(32, 5);
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

const okFire = () => vi.fn(async () => ({ ok: true, httpStatus: 200, responseSnippet: null, error: null, renderedPayload: '{}', unresolved: [] }));

async function activeFlow(tenantId: string, steps: Array<{ kind: StepKind; config: Record<string, unknown> }>) {
  const f = await createFlow(pool, { tenantId, name: 'F' });
  await replaceSteps(pool, tenantId, f.id, steps);
  await activateFlow(pool, tenantId, f.id);
  return f;
}

describe('whatsapp_send flow step', () => {
  it('sends the rendered message with a stable idempotency key and completes', async () => {
    const t = await createTenant(pool);
    const f = await activeFlow(t.id, [
      { kind: 'whatsapp_send', config: { message: 'Hi {{name}}, about {{reason}}.' } },
    ]);
    await enroll(pool, { tenantId: t.id, flowId: f.id, recipients: [{ name: 'Renier', phone: '+27609381283', context: { reason: 'your claim' } }] });
    const enrollmentId = (await listEnrollments(pool, t.id, f.id, {})).enrollments[0].id;

    const sendWa: WaSendFn = vi.fn(async () => ({ ok: true, error: null }));
    const s = await runFlowQueue(pool, KEY, { batchSize: 10, maxStepsPerTick: 50 }, okFire(), sendWa);

    expect(s.messages).toBe(1);
    expect(s.completed).toBe(1);
    expect(vi.mocked(sendWa).mock.calls[0][2]).toEqual({
      tenantId: t.id, to: '+27609381283', text: 'Hi Renier, about your claim.', idempotencyKey: `flow:${enrollmentId}:0`,
    });
  });

  it('fails the enrollment when the send fails', async () => {
    const t = await createTenant(pool);
    const f = await activeFlow(t.id, [{ kind: 'whatsapp_send', config: { message: 'Hi' } }]);
    await enroll(pool, { tenantId: t.id, flowId: f.id, recipients: [{ name: 'X', phone: '+27600000000' }] });

    const sendWa: WaSendFn = vi.fn(async () => ({ ok: false, error: 'no_whatsapp_connection' }));
    const s = await runFlowQueue(pool, KEY, { batchSize: 10, maxStepsPerTick: 50 }, okFire(), sendWa);

    expect(s.failed).toBe(1);
    expect(s.messages).toBe(0);
    const e = (await listEnrollments(pool, t.id, f.id, {})).enrollments[0];
    expect(e.status).toBe('failed');
    expect(e.last_error).toBe('no_whatsapp_connection');
  });

  it('PUT /api/flows/:id/steps accepts whatsapp_send and rejects an empty message', async () => {
    const t = await createTenant(pool);
    const password = 'pw-12345678';
    await createUser(pool, { tenantId: t.id, email: 'admin@x.io', password, role: 'tenant_admin' });
    const csrf = await csrfFor(app);
    const headers = await login(app, { email: 'admin@x.io', password }, csrf);

    const create = await app.inject({ method: 'POST', url: '/api/flows', headers, payload: { name: 'WA flow' } });
    const flowId = JSON.parse(create.body).flow.id;

    const ok = await app.inject({ method: 'PUT', url: `/api/flows/${flowId}/steps`, headers,
      payload: { steps: [{ kind: 'whatsapp_send', config: { message: 'Hi {{name}}' } }] } });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).steps[0].kind).toBe('whatsapp_send');

    const bad = await app.inject({ method: 'PUT', url: `/api/flows/${flowId}/steps`, headers,
      payload: { steps: [{ kind: 'whatsapp_send', config: { message: '   ' } }] } });
    expect(bad.statusCode).toBe(400);
  });
});
