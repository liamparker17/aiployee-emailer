import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createSmtpConfig } from '../src/repos/smtpConfigs.js';
import { createSender } from '../src/repos/senders.js';
import { createTemplate } from '../src/repos/templates.js';
import { addSuppression } from '../src/repos/suppressions.js';
import { queueEmail } from '../src/send/pipeline.js';

const KEY = Buffer.alloc(32, 1);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

async function setup() {
  const t = await createTenant(pool);
  const sc = await createSmtpConfig(pool, KEY, {
    tenantId: t.id, name: 'SES', host: 'h', port: 25, secure: false,
    username: 'u', password: 'p', fromDomain: 'x.com', isDefault: true,
  });
  const s = await createSender(pool, { tenantId: t.id, email: 'a@x.com', displayName: 'A', smtpConfigId: sc.id });
  return { t, s };
}

describe('queueEmail', () => {
  it('inserts queued email for raw subject+html send', async () => {
    const { t, s } = await setup();
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const r = await queueEmail({
      pool, enqueueSend: enqueue,
      input: { tenantId: t.id, from: s.email, to: 'r@x.com', subject: 'Hi', html: '<p>hi</p>' },
    });
    expect(r.status).toBe('queued');
    expect(enqueue).toHaveBeenCalledWith(r.id);
  });

  it('renders template + variables', async () => {
    const { t, s } = await setup();
    await createTemplate(pool, {
      tenantId: t.id, name: 'welcome',
      subject: 'Hi {{name}}', bodyHtml: '<p>Hello {{name}}</p>',
    });
    const r = await queueEmail({
      pool, enqueueSend: async () => {},
      input: { tenantId: t.id, from: s.email, to: 'r@x.com', template: 'welcome', variables: { name: 'Alex' } },
    });
    expect(r.status).toBe('queued');
    const row = await pool.query<{ subject: string; body_html: string }>(
      `SELECT subject, body_html FROM emails WHERE id = $1`, [r.id]);
    expect(row.rows[0].subject).toBe('Hi Alex');
    expect(row.rows[0].body_html).toBe('<p>Hello Alex</p>');
  });

  it('rejects unknown sender', async () => {
    const { t } = await setup();
    await expect(queueEmail({
      pool, enqueueSend: async () => {},
      input: { tenantId: t.id, from: 'nope@x.com', to: 'r@x.com', subject: 'Hi', html: '<p>x</p>' },
    })).rejects.toMatchObject({ code: 'invalid_sender' });
  });

  it('rejects suppressed recipient (logged with status=suppressed)', async () => {
    const { t, s } = await setup();
    await addSuppression(pool, { tenantId: t.id, address: 'bad@x.com', reason: 'bounce' });
    const r = await queueEmail({
      pool, enqueueSend: async () => {},
      input: { tenantId: t.id, from: s.email, to: 'bad@x.com', subject: 'Hi', html: '<p>x</p>' },
    });
    expect(r.status).toBe('suppressed');
  });

  it('records scheduled_for without enqueueing immediately', async () => {
    const { t, s } = await setup();
    const enqueue = vi.fn();
    const future = new Date(Date.now() + 60_000);
    const r = await queueEmail({
      pool, enqueueSend: enqueue,
      input: { tenantId: t.id, from: s.email, to: 'r@x.com', subject: 'Hi', html: '<p>x</p>', scheduled_for: future },
    });
    expect(r.status).toBe('queued');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
