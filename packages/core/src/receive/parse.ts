import { simpleParser } from 'mailparser';

export interface ParsedInbound {
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  fromAddr: string;
  fromName: string | null;
  toAddr: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  receivedAt: Date;
}

export async function parseRawEmail(source: Buffer): Promise<ParsedInbound> {
  const m = await simpleParser(source);
  const fromValue = m.from?.value?.[0];
  const references = Array.isArray(m.references)
    ? m.references.join(' ')
    : (m.references ?? null);
  const toText = (() => {
    const to = m.to;
    if (!to) return null;
    return Array.isArray(to) ? to.map(t => t.text).join(', ') : to.text;
  })();
  return {
    messageId: m.messageId ?? null,
    inReplyTo: m.inReplyTo ?? null,
    references: references && references.length ? references : null,
    fromAddr: fromValue?.address ?? '',
    fromName: fromValue?.name || null,
    toAddr: toText ?? null,
    subject: m.subject ?? null,
    bodyText: m.text ?? null,
    // Intentionally NOT stored: full inbound HTML averages ~1.3MB/email (base64
    // inline images) and nothing reads it — every consumer uses body_text. Storing
    // it once blew the DB to 506MB / 96% of all data. See scripts/db-size-probe.cjs.
    bodyHtml: null,
    receivedAt: m.date ?? new Date(),
  };
}
