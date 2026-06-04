import type pg from 'pg';
import { getLineReportConfig, upsertLineReportConfig } from '../../repos/lineReportConfigs.js';
import { suggestCategories } from './categorySuggest.js';
import { tagNewCalls } from './lineTagger.js';

interface LlmLike { chat(a: { model: string; messages: Array<{ role: string; content: string }> }): Promise<{ content: string }>; }

const MAX_CATEGORIES = 15;
const MAX_LEN = 40;

function normalise(categories: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of categories) {
    const v = (raw ?? '').trim().slice(0, MAX_LEN);
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= MAX_CATEGORIES) break;
  }
  return out;
}

/**
 * Reversible config write. Guards against clobbering an existing taxonomy unless
 * `replace` is set. Returns the effective taxonomy and whether a write happened.
 */
export async function applyCategories(
  pool: pg.Pool, tenantId: string, categories: string[], opts?: { replace?: boolean },
): Promise<{ categories: string[]; applied: boolean }> {
  const next = normalise(categories);
  const cfg = await getLineReportConfig(pool, tenantId);
  const existing = cfg?.taxonomy ?? [];
  if (existing.length > 0 && opts?.replace !== true) return { categories: existing, applied: false };
  if (next.length === 0) return { categories: existing, applied: false };
  const saved = await upsertLineReportConfig(pool, tenantId, { taxonomy: next });
  return { categories: saved.taxonomy, applied: true };
}

/**
 * Derive categories from real calls (unless caller supplies them), apply them
 * (guarded), and — only if a write happened — tag existing inbound calls.
 */
export async function setupCategories(args: {
  pool: pg.Pool; tenantId: string; llm: LlmLike; model: string; categories?: string[]; replace?: boolean;
}): Promise<{ categories: string[]; tagged: number; applied: boolean }> {
  const proposed = args.categories && args.categories.length
    ? args.categories
    : await suggestCategories({ pool: args.pool, tenantId: args.tenantId, llm: args.llm, model: args.model });
  const { categories, applied } = await applyCategories(args.pool, args.tenantId, proposed, { replace: args.replace });
  let tagged = 0;
  if (applied) {
    for (let i = 0; i < 50; i++) {
      const n = await tagNewCalls({ pool: args.pool, tenantId: args.tenantId, llm: args.llm, model: args.model, batch: 100 });
      if (n === 0) break;
      tagged += n;
    }
  }
  return { categories, tagged, applied };
}

/**
 * Idempotent auto-setup: applies a derived taxonomy ONLY when none exists yet and
 * the tenant has inbound calls to derive from. Otherwise a no-op returning [].
 */
export async function ensureCategories(args: {
  pool: pg.Pool; tenantId: string; llm: LlmLike; model: string;
}): Promise<string[]> {
  const cfg = await getLineReportConfig(args.pool, args.tenantId);
  if (cfg && cfg.taxonomy.length > 0) return cfg.taxonomy;
  const { rows } = await args.pool.query<{ n: string }>(
    `SELECT count(*)::text n FROM agent_messages WHERE tenant_id = $1 AND role = 'inbound'`, [args.tenantId]);
  if (Number(rows[0].n) === 0) return [];
  const cats = await suggestCategories({ pool: args.pool, tenantId: args.tenantId, llm: args.llm, model: args.model });
  if (!cats.length) return [];
  const { categories } = await applyCategories(args.pool, args.tenantId, cats, { replace: false });
  return categories;
}
