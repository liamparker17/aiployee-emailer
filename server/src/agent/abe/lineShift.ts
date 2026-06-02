import type pg from 'pg';
import { getLineReportConfig } from '../../repos/lineReportConfigs.js';
import { aggregateByCategory, listHighSeverityUnreported } from '../../repos/lineCallTags.js';
import { tagNewCalls } from './lineTagger.js';
import { detectSpikes } from './lineSpike.js';
import { composeDigest, composeAlert, composeCase } from './lineCompose.js';

type LlmLike = { chat(a: { model: string; messages: Array<{ role: string; content: string }> }): Promise<{ content: string }> };
export type LineShiftResult =
  | { status: 'skipped'; reason: string }
  | { status: 'ran'; tagged: number; alerts: number; cases: number; digests: number };

const DAY = 86_400_000;

export async function runLineReportShift(args: {
  pool: pg.Pool; tenantId: string; llmFactory: (key?: string) => LlmLike; model: string; now: Date; openAiKey?: string;
}): Promise<LineShiftResult> {
  const { pool, tenantId, model, now } = args;
  const cfg = await getLineReportConfig(pool, tenantId);
  if (!cfg || !cfg.enabled) return { status: 'skipped', reason: 'disabled' };
  const llm = args.llmFactory(args.openAiKey);

  const tagged = await tagNewCalls({ pool, tenantId, llm, model, batch: 100 });

  const end = now, start = new Date(now.getTime() - DAY);
  const current = await aggregateByCategory(pool, tenantId, start, end);
  const baseStart = new Date(start.getTime() - cfg.baseline_periods * DAY);
  const base = await aggregateByCategory(pool, tenantId, baseStart, start);
  const baselineAvg: Record<string, number> = {};
  for (const b of base) baselineAvg[b.category] = b.count / cfg.baseline_periods;

  let alerts = 0;
  for (const s of detectSpikes({ current, baselineAvg, spikePct: cfg.spike_pct, spikeMinCount: cfg.spike_min_count })) {
    await composeAlert({ pool, tenantId, llm, model, spike: s }); alerts++;
  }

  let cases = 0;
  for (const hc of await listHighSeverityUnreported(pool, tenantId, baseStart)) {
    await composeCase({ pool, tenantId, llm, model, messageId: hc.message_id, content: hc.content }); cases++;
  }

  let digests = 0;
  if (cfg.daily_digest) { await composeDigest({ pool, tenantId, llm, model, periodLabel: 'daily', start, end }); digests++; }
  if (cfg.weekly_rollup && now.getUTCDay() === cfg.weekly_send_day) {
    const wStart = new Date(now.getTime() - 7 * DAY);
    await composeDigest({ pool, tenantId, llm, model, periodLabel: 'weekly', start: wStart, end }); digests++;
  }

  return { status: 'ran', tagged, alerts, cases, digests };
}
