import type { FastifyInstance } from 'fastify';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { requireTenantCtx } from '@aiployee/core';

// Files recipients can receive as email attachments. PDFs cover the campaign use case;
// extend this list deliberately (nodemailer fetches the blob URL at send time).
const ALLOWED_CONTENT_TYPES = ['application/pdf'];
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — typical mailbox attachment ceiling.

// Resolve the Vercel Blob read-write token from the environment. The default name is
// BLOB_READ_WRITE_TOKEN, but a store connected with a custom prefix exposes it as
// <PREFIX>_READ_WRITE_TOKEN — so fall back to any var whose value is a blob rw token.
function resolveBlobToken(): string | undefined {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  for (const [k, v] of Object.entries(process.env)) {
    if (k.endsWith('READ_WRITE_TOKEN') && typeof v === 'string' && v.startsWith('vercel_blob_rw_')) return v;
  }
  return undefined;
}

/**
 * Client-upload token endpoint for campaign attachments. The browser streams the file
 * straight to Vercel Blob (bypassing Vercel's ~4.5 MB function request-body limit); this
 * route only mints a short-lived, size/type-restricted upload token after confirming the
 * caller has an authenticated tenant session. Exempt from CSRF (see registerCsrf) because
 * the @vercel/blob client posts here directly and the Blob upload-completed callback comes
 * from Vercel's servers — auth is enforced inside onBeforeGenerateToken instead.
 */
export async function registerBlobRoutes(app: FastifyInstance) {
  app.post('/api/blob/upload', async (req, reply) => {
    const body = req.body as HandleUploadBody;
    // Fail loudly (and legibly) if the Blob store isn't wired to this deployment, rather than
    // bubbling up the SDK's opaque "No blob credentials found" through a generic 400.
    const token = resolveBlobToken();
    if (!token) {
      // Log the candidate var NAMES (never values) so a misnamed token is obvious in the logs.
      const candidates = Object.keys(process.env).filter(k => k.includes('BLOB') || k.endsWith('READ_WRITE_TOKEN'));
      app.log.error({ candidates }, 'no Vercel Blob read-write token found in env');
      return reply.code(503).send({ error: { code: 'blob_not_configured', message: 'Attachment storage is not configured on the server yet.' } });
    }
    try {
      const jsonResponse = await handleUpload({
        token,
        body,
        request: req.raw,
        onBeforeGenerateToken: async () => {
          const ctx = requireTenantCtx(req); // throws if not authenticated
          return {
            allowedContentTypes: ALLOWED_CONTENT_TYPES,
            addRandomSuffix: true,
            maximumSizeInBytes: MAX_BYTES,
            tokenPayload: JSON.stringify({ tenantId: ctx.tenantId }),
          };
        },
        // No onUploadCompleted: the client receives the blob URL directly from upload(),
        // so we don't need Vercel's post-upload callback (and avoid registering a callbackUrl).
      });
      return reply.send(jsonResponse);
    } catch (e) {
      app.log.error({ err: e }, 'blob upload token generation failed');
      // 400 lets the @vercel/blob client surface the message to the user.
      return reply.code(400).send({ error: { code: 'blob_upload_failed', message: (e as Error).message } });
    }
  });
}
