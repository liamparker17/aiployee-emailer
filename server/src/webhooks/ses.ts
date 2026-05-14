import https from 'node:https';
import { createVerify } from 'node:crypto';

interface SnsMessage {
  Type: string;
  MessageId: string;
  Token?: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  SubscribeURL?: string;
}

const certCache = new Map<string, string>();

async function fetchCert(url: string): Promise<string> {
  if (certCache.has(url)) return certCache.get(url)!;
  if (!/^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com\//.test(url)) throw new Error('invalid SigningCertURL');
  const cert = await new Promise<string>((resolve, reject) => {
    https.get(url, (res) => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', c => (data += c));
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
  certCache.set(url, cert);
  return cert;
}

function buildStringToSign(m: SnsMessage): string {
  const fields = m.Type === 'Notification'
    ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
    : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  let s = '';
  for (const k of fields) {
    const v = (m as unknown as Record<string, string | undefined>)[k];
    if (v !== undefined) s += `${k}\n${v}\n`;
  }
  return s;
}

export async function verifySnsMessage(msg: SnsMessage): Promise<void> {
  const cert = await fetchCert(msg.SigningCertURL);
  const verify = createVerify(msg.SignatureVersion === '2' ? 'sha256WithRSAEncryption' : 'sha1WithRSAEncryption');
  verify.update(buildStringToSign(msg), 'utf8');
  if (!verify.verify(cert, msg.Signature, 'base64')) throw new Error('SNS signature invalid');
}

export interface ParsedSesEvent {
  type: 'bounce' | 'complaint' | 'delivery';
  messageId: string;
  recipients: string[];
}

export function parseSesNotification(messageJson: string): ParsedSesEvent | null {
  const m = JSON.parse(messageJson) as {
    notificationType?: string; eventType?: string;
    mail?: { messageId: string };
    bounce?: { bounceType: string; bouncedRecipients: { emailAddress: string }[] };
    complaint?: { complainedRecipients: { emailAddress: string }[] };
  };
  const t = (m.notificationType ?? m.eventType ?? '').toLowerCase();
  if (!m.mail?.messageId) return null;
  if (t === 'bounce' && m.bounce?.bounceType === 'Permanent') {
    return { type: 'bounce', messageId: m.mail.messageId, recipients: m.bounce.bouncedRecipients.map(r => r.emailAddress) };
  }
  if (t === 'complaint' && m.complaint) {
    return { type: 'complaint', messageId: m.mail.messageId, recipients: m.complaint.complainedRecipients.map(r => r.emailAddress) };
  }
  if (t === 'delivery') {
    return { type: 'delivery', messageId: m.mail.messageId, recipients: [] };
  }
  return null;
}
