import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireTenantCtx } from '@aiployee/core';
import { AppError, sendError } from '@aiployee/core';
import {
  listReports,
  getReport,
  setReportStatus,
  type ReportStatus,
} from '../repos/lineReports.js';
import { getLineReportConfig, upsertLineReportConfig } from '../repos/lineReportConfigs.js';
import { approveAndSendReport } from '../agent/abe/lineSend.js';

function requireAdmin(ctx: ReturnType<typeof requireTenantCtx>): void {
  if (ctx.role !== 'tenant_admin' && ctx.role !== 'super_admin') {
    throw new AppError('forbidden', 403, 'Admin role required');
  }
}

const PatchBody = z.object({
  subject: z.string().min(1).max(500).optional(),
  body: z.string().min(1).max(50000).optional(),
  advisory: z.record(z.unknown()).optional(),
});

const RejectBody = z.object({
  reason: z.string().max(1000).optional(),
});

const SettingsBody = z.object({
  enabled: z.boolean().optional(),
  dailyDigest: z.boolean().optional(),
  weeklyRollup: z.boolean().optional(),
  weeklySendDay: z.number().int().min(0).max(6).optional(),
  sendHourUtc: z.number().int().min(0).max(23).optional(),
  recipients: z.array(z.string()).optional(),
  taxonomy: z.array(z.string()).optional(),
  spikePct: z.number().optional(),
  spikeMinCount: z.number().int().optional(),
  baselinePeriods: z.number().int().optional(),
  brandVoice: z.string().max(2000).optional(),
  clientName: z.string().max(200).trim().nullable().optional(),
  clientContext: z.string().max(2000).trim().nullable().optional(),
});

export function registerLineReportRoutes(app: FastifyInstance): void {
  // ── Reports ──────────────────────────────────────────────────────────────────

  app.get('/api/agent/line-reports', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      requireAdmin(ctx);
      const { status } = req.query as { status?: string };
      const reports = await listReports(app.pool, ctx.tenantId, status as ReportStatus | undefined);
      return reply.send({ reports });
    } catch (e) { sendError(reply, e); }
  });

  app.get('/api/agent/line-reports/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      requireAdmin(ctx);
      const { id } = req.params as { id: string };
      const report = await getReport(app.pool, ctx.tenantId, id);
      if (!report) throw new AppError('not_found', 404, 'Report not found');
      return reply.send({ report });
    } catch (e) { sendError(reply, e); }
  });

  app.patch('/api/agent/line-reports/:id', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      requireAdmin(ctx);
      const { id } = req.params as { id: string };
      const report = await getReport(app.pool, ctx.tenantId, id);
      if (!report) throw new AppError('not_found', 404, 'Report not found');
      if (report.status !== 'pending_approval') {
        throw new AppError('conflict', 409, `Cannot edit report with status '${report.status}'`);
      }
      const body = PatchBody.parse(req.body);
      const sets: string[] = [];
      const vals: unknown[] = [ctx.tenantId, id];
      if (body.subject !== undefined) { vals.push(body.subject); sets.push(`subject = $${vals.length}`); }
      if (body.body !== undefined) { vals.push(body.body); sets.push(`body = $${vals.length}`); }
      if (body.advisory !== undefined) { vals.push(JSON.stringify(body.advisory)); sets.push(`advisory = $${vals.length}`); }
      if (sets.length === 0) {
        return reply.send({ report });
      }
      const r = await app.pool.query(
        `UPDATE line_reports SET ${sets.join(', ')} WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        vals,
      );
      return reply.send({ report: r.rows[0] });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/agent/line-reports/:id/approve', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      requireAdmin(ctx);
      const { id } = req.params as { id: string };
      const result = await approveAndSendReport({
        pool: app.pool,
        encKey: app.cfg.encKey,
        baseUrl: app.cfg.publicBaseUrl,
        tenantId: ctx.tenantId,
        reportId: id,
        approvedBy: ctx.userId ?? 'unknown',
      });
      if (!result.ok) {
        throw new AppError('cannot_send', 400, result.reason);
      }
      return reply.send({ report: result.report });
    } catch (e) { sendError(reply, e); }
  });

  app.post('/api/agent/line-reports/:id/reject', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      requireAdmin(ctx);
      const { id } = req.params as { id: string };
      const body = RejectBody.parse(req.body ?? {});
      const updated = await setReportStatus(app.pool, ctx.tenantId, id, 'archived', {
        rejectReason: body.reason,
      });
      if (!updated) throw new AppError('not_found', 404, 'Report not found');
      return reply.send({ report: updated });
    } catch (e) { sendError(reply, e); }
  });

  // ── Settings ─────────────────────────────────────────────────────────────────

  app.get('/api/agent/line-report-settings', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      requireAdmin(ctx);
      const config = await getLineReportConfig(app.pool, ctx.tenantId);
      return reply.send({ config });
    } catch (e) { sendError(reply, e); }
  });

  app.put('/api/agent/line-report-settings', async (req, reply) => {
    try {
      const ctx = requireTenantCtx(req);
      requireAdmin(ctx);
      const body = SettingsBody.parse(req.body);
      const config = await upsertLineReportConfig(app.pool, ctx.tenantId, body);
      return reply.send({ config });
    } catch (e) { sendError(reply, e); }
  });
}
