import type pg from 'pg';

export interface LineReportConfigRow {
  id: string;
  tenant_id: string;
  enabled: boolean;
  daily_digest: boolean;
  weekly_rollup: boolean;
  weekly_send_day: number;
  send_hour_utc: number;
  recipients: string[];
  taxonomy: string[];
  spike_pct: number;
  spike_min_count: number;
  baseline_periods: number;
  brand_voice: string | null;
  client_name: string | null;
  client_context: string | null;
  ingest_sends_as_calls: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * Sparse-patch semantics: an omitted field keeps the existing DB value.
 * Numeric fields are clamped to valid bounds before storage.
 * recipients are filtered — invalid email addresses are silently dropped.
 */
export interface LineReportConfigPatch {
  enabled?: boolean;
  dailyDigest?: boolean;
  weeklyRollup?: boolean;
  weeklySendDay?: number;
  sendHourUtc?: number;
  recipients?: string[];
  taxonomy?: string[];
  spikePct?: number;
  spikeMinCount?: number;
  baselinePeriods?: number;
  brandVoice?: string;
  clientName?: string | null;
  clientContext?: string | null;
  ingestSendsAsCalls?: boolean;
}

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.round(n)));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function listEnabledLineConfigs(pool: pg.Pool): Promise<LineReportConfigRow[]> {
  const r = await pool.query<LineReportConfigRow>(`SELECT * FROM line_report_configs WHERE enabled = true`);
  return r.rows;
}

export async function getLineReportConfig(
  pool: pg.Pool,
  tenantId: string,
): Promise<LineReportConfigRow | null> {
  const r = await pool.query<LineReportConfigRow>(
    `SELECT * FROM line_report_configs WHERE tenant_id = $1`,
    [tenantId],
  );
  return r.rows[0] ?? null;
}

export async function upsertLineReportConfig(
  pool: pg.Pool,
  tenantId: string,
  patch: LineReportConfigPatch,
): Promise<LineReportConfigRow> {
  const recipients = patch.recipients != null
    ? patch.recipients.map(s => s.trim()).filter(s => EMAIL_RE.test(s))
    : null;
  const taxonomy = patch.taxonomy != null
    ? patch.taxonomy.map(s => s.trim()).filter(Boolean)
    : null;

  const r = await pool.query<LineReportConfigRow>(
    `INSERT INTO line_report_configs
       (tenant_id, enabled, daily_digest, weekly_rollup, weekly_send_day, send_hour_utc,
        recipients, taxonomy, spike_pct, spike_min_count, baseline_periods, brand_voice,
        client_name, client_context, ingest_sends_as_calls)
     VALUES ($1,
        COALESCE($2, false), COALESCE($3, true), COALESCE($4, true),
        COALESCE($5, 1), COALESCE($6, 6),
        COALESCE($7, '[]'::jsonb), COALESCE($8, $9::jsonb),
        COALESCE($10, 50), COALESCE($11, 5), COALESCE($12, 4), $13,
        $15, $16,
        COALESCE($14, false))
     ON CONFLICT (tenant_id) DO UPDATE SET
        enabled          = COALESCE($2,  line_report_configs.enabled),
        daily_digest     = COALESCE($3,  line_report_configs.daily_digest),
        weekly_rollup    = COALESCE($4,  line_report_configs.weekly_rollup),
        weekly_send_day  = COALESCE($5,  line_report_configs.weekly_send_day),
        send_hour_utc    = COALESCE($6,  line_report_configs.send_hour_utc),
        recipients       = COALESCE($7,  line_report_configs.recipients),
        taxonomy         = COALESCE($8,  line_report_configs.taxonomy),
        spike_pct        = COALESCE($10, line_report_configs.spike_pct),
        spike_min_count  = COALESCE($11, line_report_configs.spike_min_count),
        baseline_periods = COALESCE($12, line_report_configs.baseline_periods),
        brand_voice      = COALESCE($13, line_report_configs.brand_voice),
        client_name      = COALESCE($15, line_report_configs.client_name),
        client_context   = COALESCE($16, line_report_configs.client_context),
        ingest_sends_as_calls = COALESCE($14, line_report_configs.ingest_sends_as_calls),
        updated_at       = now()
     RETURNING *`,
    [
      tenantId,
      patch.enabled   ?? null,
      patch.dailyDigest  ?? null,
      patch.weeklyRollup ?? null,
      patch.weeklySendDay != null ? clamp(patch.weeklySendDay, 0, 6) : null,
      patch.sendHourUtc   != null ? clamp(patch.sendHourUtc, 0, 23)  : null,
      recipients != null ? JSON.stringify(recipients) : null,
      taxonomy   != null ? JSON.stringify(taxonomy)   : null,
      '[]',                                                              // $9 — empty default for taxonomy INSERT (Abe derives categories per-tenant)
      patch.spikePct        != null ? clamp(patch.spikePct, 0, 500)   : null,
      patch.spikeMinCount   != null ? clamp(patch.spikeMinCount, 1, 1000) : null,
      patch.baselinePeriods != null ? clamp(patch.baselinePeriods, 1, 12) : null,
      patch.brandVoice ?? null,
      patch.ingestSendsAsCalls ?? null,
      patch.clientName ?? null,
      patch.clientContext ?? null,
    ],
  );
  return r.rows[0];
}
