import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';

interface MailgunEnvelope {
  signature?: { timestamp: string; token: string; signature: string };
  'event-data'?: {
    event: string;
    severity?: string;
    recipient: string;
    message?: { headers?: { 'message-id'?: string } };
  };
}

export function verifyMailgun(body: MailgunEnvelope, cfg: Config): void {
  const sig = body.signature;
  if (!sig) throw new Error('missing signature');
  const key = process.env.MAILGUN_SIGNING_KEY;
  if (!key) throw new Error('MAILGUN_SIGNING_KEY not set');
  const computed = createHmac('sha256', key).update(sig.timestamp + sig.token).digest('hex');
  const a = Buffer.from(computed); const b = Buffer.from(sig.signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('invalid signature');
  // 5 minute window
  if (Math.abs(Date.now() / 1000 - Number(sig.timestamp)) > 300) throw new Error('signature expired');
  void cfg;
}

export function parseMailgunEvent(body: MailgunEnvelope): {
  type: 'bounce' | 'complaint' | 'delivery'; messageId: string; recipient: string;
} | null {
  const e = body['event-data']; if (!e) return null;
  const messageId = (e.message?.headers?.['message-id'] ?? '').replace(/^<|>$/g, '');
  if (!messageId) return null;
  if (e.event === 'failed' && e.severity === 'permanent') return { type: 'bounce', messageId, recipient: e.recipient };
  if (e.event === 'complained') return { type: 'complaint', messageId, recipient: e.recipient };
  if (e.event === 'delivered') return { type: 'delivery', messageId, recipient: e.recipient };
  return null;
}
