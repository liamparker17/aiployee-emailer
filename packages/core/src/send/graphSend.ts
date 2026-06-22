// Send email via Microsoft Graph API (delegated Mail.Send).
// Bypasses SMTP-AUTH entirely — useful when Exchange Online has SMTP-AUTH disabled
// at the tenant or mailbox level but the user has granted Mail.Send via device-code OAuth.

export interface GraphMessage {
  from: string;
  to: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string | null;
  subject: string;
  html?: string | null;
  text?: string | null;
  attachments?: Array<{
    filename?: string;
    path?: string;
    content?: string | Buffer;
    contentType?: string;
  }>;
}

type FetchLike = typeof fetch;

/**
 * Send an email via Microsoft Graph (delegated Mail.Send). Bypasses SMTP.
 * Returns the Graph request-id header value as messageId (or null if absent).
 */
export async function sendViaGraph(
  accessToken: string,
  msg: GraphMessage,
  fetchImpl: FetchLike = fetch,
): Promise<{ messageId: string | null }> {
  const addr = (a: string) => ({ emailAddress: { address: a } });

  // Build attachments array — inline base64 or fetched from a URL.
  const attachments: Array<Record<string, unknown>> = [];
  for (const at of msg.attachments ?? []) {
    let contentBytes: string;
    if (at.content != null) {
      contentBytes = Buffer.isBuffer(at.content)
        ? at.content.toString('base64')
        : Buffer.from(at.content).toString('base64');
    } else if (at.path) {
      const r = await fetchImpl(at.path as Parameters<FetchLike>[0], undefined as never);
      const buf = Buffer.from(await r.arrayBuffer());
      contentBytes = buf.toString('base64');
    } else {
      continue;
    }
    attachments.push({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: at.filename ?? 'attachment',
      contentType: at.contentType ?? 'application/octet-stream',
      contentBytes,
    });
  }

  const message: Record<string, unknown> = {
    subject: msg.subject,
    body: {
      contentType: msg.html ? 'HTML' : 'Text',
      content: msg.html ?? msg.text ?? '',
    },
    toRecipients: [addr(msg.to)],
    from: addr(msg.from),
  };

  if (msg.cc?.length) message.ccRecipients = msg.cc.map(addr);
  if (msg.bcc?.length) message.bccRecipients = msg.bcc.map(addr);
  if (msg.replyTo) message.replyTo = [addr(msg.replyTo)];
  if (attachments.length) message.attachments = attachments;

  const res = await fetchImpl(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(msg.from)}/sendMail` as Parameters<FetchLike>[0],
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message, saveToSentItems: true }),
    } as Parameters<FetchLike>[1],
  );

  if (res.status !== 202) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`Graph sendMail failed (${res.status}): ${bodyText.slice(0, 300)}`);
  }

  return { messageId: res.headers.get('request-id') };
}
