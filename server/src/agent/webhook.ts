import { createHmac } from 'node:crypto';
import type pg from 'pg';
import { getJobixWebhook, type MessageRow } from '../repos/agent.js';

export interface WebhookPayload {
  event: 'agent.response';
  thread_ref: string;
  message_id: string;
  status: 'sent' | 'drafted' | 'rejected';
  response_text: string;
  actions: Array<Record<string, unknown>>;
  ts: string;
}

/** Injectable so tests can capture deliveries instead of making real HTTP calls. */
export interface WebhookSender {
  send(args: { url: string; signature: string; body: string }): Promise<{ ok: boolean; status?: number }>;
}

export const fetchWebhookSender: WebhookSender = {
  async send({ url, signature, body }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Aiployee-Signature': signature },
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

export function signBody(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Deliver a thread event to the tenant's configured Jobix webhook. No-op (returns
 * { delivered:false, reason:'not_configured' }) if no webhook is set. Best-effort:
 * a delivery failure is reported but never throws (it must not break the agent run).
 */
export async function deliverThreadEvent(args: {
  pool: pg.Pool; encKey: Buffer; tenantId: string;
  threadRef: string; message: MessageRow; status: WebhookPayload['status'];
  actions?: WebhookPayload['actions']; ts: string; sender?: WebhookSender;
}): Promise<{ delivered: boolean; reason?: string; httpStatus?: number }> {
  const hook = await getJobixWebhook(args.pool, args.encKey, args.tenantId);
  if (!hook) return { delivered: false, reason: 'not_configured' };
  const payload: WebhookPayload = {
    event: 'agent.response',
    thread_ref: args.threadRef,
    message_id: args.message.id,
    status: args.status,
    response_text: args.message.content,
    actions: args.actions ?? [],
    ts: args.ts,
  };
  const body = JSON.stringify(payload);
  const signature = signBody(body, hook.secret);
  const res = await (args.sender ?? fetchWebhookSender).send({ url: hook.url, signature, body });
  return { delivered: res.ok, reason: res.ok ? undefined : 'delivery_failed', httpStatus: res.status };
}
