import { createHmac } from 'node:crypto';
import type pg from 'pg';
import { listTargetsForEvent } from '../repos/eventWebhooks.js';

export interface EventSender {
  send(args: { url: string; signature: string; body: string }): Promise<{ ok: boolean; status?: number }>;
}

export const fetchEventSender: EventSender = {
  async send({ url, signature, body }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Aiployee-Signature': signature,
        },
        body,
        signal: controller.signal,
      });
      return { ok: res.ok, status: res.status };
    } catch {
      return { ok: false };
    } finally {
      clearTimeout(timer);
    }
  },
};

export function signEventBody(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

export async function deliverEmailEvent(args: {
  pool: pg.Pool;
  encKey: Buffer;
  tenantId: string;
  event: string;
  payload: Record<string, unknown>;
  sender?: EventSender;
}): Promise<void> {
  const targets = await listTargetsForEvent(args.pool, args.encKey, args.tenantId, args.event);
  const sender = args.sender ?? fetchEventSender;
  for (const target of targets) {
    try {
      const body = JSON.stringify({ event: args.event, ...args.payload, ts: new Date().toISOString() });
      const signature = signEventBody(body, target.secret);
      await sender.send({ url: target.url, signature, body });
    } catch {
      // best-effort: delivery failures must never propagate
    }
  }
}
