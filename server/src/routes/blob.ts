import type { FastifyInstance } from 'fastify';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { requireTenantCtx } from '@aiployee/core';

// Files recipients can receive as email attachments. PDFs cover the campaign use case;
// extend this list deliberately (nodemailer fetches the blob URL at send time).
const ALLOWED_CONTENT_TYPES = ['application/pdf'];
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — typical mailbox attachment ceiling.

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
    try {
      const jsonResponse = await handleUpload({
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
        // The client receives the blob URL directly from upload(); nothing to persist here.
        onUploadCompleted: async () => {},
      });
      return reply.send(jsonResponse);
    } catch (e) {
      // 400 lets the @vercel/blob client surface the message to the user.
      return reply.code(400).send({ error: { code: 'blob_upload_failed', message: (e as Error).message } });
    }
  });
}
