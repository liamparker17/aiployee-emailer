// Open/click tracking: a 1x1 pixel records opens; http(s) links are rewritten to a
// redirect endpoint that records the click then forwards to the original URL.

// 1x1 transparent GIF.
export const TRACKING_PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64',
);

export function injectTracking(html: string, opts: { emailId: string; baseUrl: string }): string {
  const base = opts.baseUrl.replace(/\/+$/, '');
  // Rewrite double-quoted http(s) links only (skips mailto:, tel:, #anchors, and
  // anything already pointing at our tracker).
  let out = html.replace(/href="(https?:\/\/[^"]+)"/gi, (m, url: string) => {
    if (url.startsWith(`${base}/v1/track/`)) return m;
    return `href="${base}/v1/track/click/${opts.emailId}?u=${encodeURIComponent(url)}"`;
  });
  const pixel = `<img src="${base}/v1/track/open/${opts.emailId}" width="1" height="1" alt="" style="display:none" />`;
  out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${pixel}</body>`) : out + pixel;
  return out;
}
