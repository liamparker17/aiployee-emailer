import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { createEventWebhook } from '@aiployee/core';
import { deliverEmailEvent, signEventBody } from '@aiployee/core';
import { createSendingDomain, setDomainVerification, listSendingDomains } from '@aiployee/core';

const KEY = Buffer.alloc(32, 1);
const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('event webhook delivery', () => {
  it('delivers an HMAC-signed payload only to webhooks subscribed to the event', async () => {
    const t = await createTenant(pool);
    await createEventWebhook(pool, KEY, { tenantId: t.id, url: 'https://jobix.example/hook', events: ['sent'], secret: 'whsec_test' });

    const captured: Array<{ url: string; signature: string; raw: string }> = [];
    const sender = {
      async send({ url, signature, body }: { url: string; signature: string; body: string }) {
        captured.push({ url, signature, raw: body });
        return { ok: true, status: 200 };
      },
    };

    await deliverEmailEvent({ pool, encKey: KEY, tenantId: t.id, event: 'sent', payload: { email_id: 'e1' }, sender });
    expect(captured).toHaveLength(1);
    const body = JSON.parse(captured[0].raw);
    expect(body.event).toBe('sent');
    expect(body.email_id).toBe('e1');
    expect(captured[0].signature).toBe(signEventBody(captured[0].raw, 'whsec_test'));

    // An event the webhook is NOT subscribed to → no delivery.
    captured.length = 0;
    await deliverEmailEvent({ pool, encKey: KEY, tenantId: t.id, event: 'bounced', payload: { email_id: 'e1' }, sender });
    expect(captured).toHaveLength(0);
  });
});

describe('sending domains', () => {
  it('tracks SPF/DMARC verification state', async () => {
    const t = await createTenant(pool);
    const d = await createSendingDomain(pool, { tenantId: t.id, domain: 'example.com' });
    expect(d.verified).toBe(false);

    const both = await setDomainVerification(pool, t.id, d.id, { spfOk: true, dmarcOk: true });
    expect(both?.verified).toBe(true);

    const partial = await setDomainVerification(pool, t.id, d.id, { spfOk: true, dmarcOk: false });
    expect(partial?.verified).toBe(false); // verified only when BOTH pass

    const list = await listSendingDomains(pool, t.id);
    expect(list).toHaveLength(1);
    expect(list[0].domain).toBe('example.com');
  });
});
