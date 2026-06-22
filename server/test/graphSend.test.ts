import { describe, it, expect, vi } from 'vitest';
import { sendViaGraph } from '@aiployee/core';

// Minimal fake fetch that returns 202 with a request-id header.
function makeFakeFetch(status: number, requestId: string | null, bodyText = '') {
  const headers = new Map<string, string>();
  if (requestId !== null) headers.set('request-id', requestId);

  return vi.fn(async (_url: unknown, init?: unknown) => {
    void _url; void init;
    return {
      status,
      headers: { get: (k: string) => headers.get(k) ?? null },
      text: async () => bodyText,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  });
}

describe('sendViaGraph', () => {
  it('posts to the correct Graph URL with correct headers and body', async () => {
    const fakeFetch = makeFakeFetch(202, 'rid-1');

    const result = await sendViaGraph(
      'tok',
      { from: 'a@x.com', to: 'b@y.com', cc: ['c@z.com'], subject: 'Hi', html: '<p>Hi</p>' },
      fakeFetch as unknown as typeof fetch,
    );

    expect(result).toEqual({ messageId: 'rid-1' });
    expect(fakeFetch).toHaveBeenCalledOnce();

    const [url, init] = fakeFetch.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe('https://graph.microsoft.com/v1.0/users/a%40x.com/sendMail');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer tok');
    expect(init.headers['Content-Type']).toBe('application/json');

    const parsed = JSON.parse(init.body) as {
      message: {
        subject: string;
        body: { contentType: string; content: string };
        toRecipients: Array<{ emailAddress: { address: string } }>;
        ccRecipients: Array<{ emailAddress: { address: string } }>;
        from: { emailAddress: { address: string } };
      };
      saveToSentItems: boolean;
    };

    expect(parsed.message.subject).toBe('Hi');
    expect(parsed.message.body.contentType).toBe('HTML');
    expect(parsed.message.toRecipients[0].emailAddress.address).toBe('b@y.com');
    expect(parsed.message.ccRecipients[0].emailAddress.address).toBe('c@z.com');
    expect(parsed.message.from.emailAddress.address).toBe('a@x.com');
    expect(parsed.saveToSentItems).toBe(true);
  });

  it('returns null messageId when request-id header is absent', async () => {
    const fakeFetch = makeFakeFetch(202, null);
    const result = await sendViaGraph(
      'tok',
      { from: 'a@x.com', to: 'b@y.com', subject: 'Test', text: 'plain' },
      fakeFetch as unknown as typeof fetch,
    );
    expect(result).toEqual({ messageId: null });
  });

  it('throws with status + body when Graph returns a non-202 response', async () => {
    const fakeFetch = makeFakeFetch(403, null, '{"error":{"code":"Forbidden","message":"Insufficient privileges"}}');
    await expect(
      sendViaGraph('bad-tok', { from: 'a@x.com', to: 'b@y.com', subject: 'X', text: 'y' }, fakeFetch as unknown as typeof fetch),
    ).rejects.toThrow('Graph sendMail failed (403)');
  });

  it('uses text body when no html is provided', async () => {
    const fakeFetch = makeFakeFetch(202, 'rid-2');
    await sendViaGraph('tok', { from: 'a@x.com', to: 'b@y.com', subject: 'S', text: 'Hello' }, fakeFetch as unknown as typeof fetch);
    const [, init] = fakeFetch.mock.calls[0] as [string, { body: string }];
    const parsed = JSON.parse(init.body) as { message: { body: { contentType: string } } };
    expect(parsed.message.body.contentType).toBe('Text');
  });

  it('includes bcc recipients when provided', async () => {
    const fakeFetch = makeFakeFetch(202, 'rid-3');
    await sendViaGraph('tok', { from: 'a@x.com', to: 'b@y.com', bcc: ['d@w.com'], subject: 'S', html: '<b>hi</b>' }, fakeFetch as unknown as typeof fetch);
    const [, init] = fakeFetch.mock.calls[0] as [string, { body: string }];
    const parsed = JSON.parse(init.body) as { message: { bccRecipients?: Array<{ emailAddress: { address: string } }> } };
    expect(parsed.message.bccRecipients?.[0]?.emailAddress.address).toBe('d@w.com');
  });

  it('includes replyTo when provided', async () => {
    const fakeFetch = makeFakeFetch(202, 'rid-4');
    await sendViaGraph('tok', { from: 'a@x.com', to: 'b@y.com', replyTo: 'r@x.com', subject: 'S', text: 't' }, fakeFetch as unknown as typeof fetch);
    const [, init] = fakeFetch.mock.calls[0] as [string, { body: string }];
    const parsed = JSON.parse(init.body) as { message: { replyTo?: Array<{ emailAddress: { address: string } }> } };
    expect(parsed.message.replyTo?.[0]?.emailAddress.address).toBe('r@x.com');
  });
});
