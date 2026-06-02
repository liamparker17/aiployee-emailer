export interface Spike { category: string; count: number; baseline: number; pctOver: number; }

export function detectSpikes(args: {
  current: Array<{ category: string; count: number }>;
  baselineAvg: Record<string, number>;
  spikePct: number; spikeMinCount: number;
}): Spike[] {
  const out: Spike[] = [];
  for (const { category, count } of args.current) {
    if (count < args.spikeMinCount) continue;
    const baseline = args.baselineAvg[category] ?? 0;
    const threshold = baseline * (1 + args.spikePct / 100);
    if (count >= threshold && (baseline > 0 || count >= args.spikeMinCount)) {
      const pctOver = baseline > 0 ? Math.round(((count - baseline) / baseline) * 100) : 100;
      out.push({ category, count, baseline, pctOver });
    }
  }
  return out;
}
