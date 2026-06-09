import { describe, it, expect } from 'vitest';
import { parseRawEmail } from '../../packages/core/src/receive/parse.js';

const RAW = Buffer.from(
  [
    'From: Jane Lead <jane@lead.com>',
    'To: box@us.com',
    'Subject: Re: Hello',
    'Message-ID: <reply-1@lead.com>',
    'In-Reply-To: <sent-1@us.com>',
    'References: <sent-1@us.com>',
    'Date: Tue, 09 Jun 2026 10:00:00 +0000',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'What are your opening hours?',
    '',
  ].join('\r\n'),
  'utf8',
);

describe('parseRawEmail', () => {
  it('extracts headers, address, and body', async () => {
    const p = await parseRawEmail(RAW);
    expect(p.messageId).toBe('<reply-1@lead.com>');
    expect(p.inReplyTo).toBe('<sent-1@us.com>');
    expect(p.references).toContain('<sent-1@us.com>');
    expect(p.fromAddr).toBe('jane@lead.com');
    expect(p.fromName).toBe('Jane Lead');
    expect(p.subject).toBe('Re: Hello');
    expect(p.bodyText?.trim()).toBe('What are your opening hours?');
    expect(p.receivedAt instanceof Date).toBe(true);
  });
});
