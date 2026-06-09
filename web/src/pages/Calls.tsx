import { useEffect, useState, type ReactNode } from 'react';
import { Phone, ChevronLeft, ChevronRight, Plus, Trash2, Loader2, Bot, Download } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import {
  listCalls,
  getCallBreakdown,
  getCategories,
  putCategories,
  suggestCategories,
  retagCalls,
  getCallSettings,
  putCallSettings,
  importPastCalls,
  autoSetupCategories,
} from '../lib/calls';
import type { CallRow, CallFilters, CallBreakdown } from '../lib/calls';
import { exportCallsCsvUrl } from '../lib/calls';
import { Table, Th, Td } from '../components/Table';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Input, Field } from '../components/Input';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';
import { Card } from '../components/Card';
import { useToast } from '../components/Toast';

// ── Error helpers ─────────────────────────────────────────────────────────────
function friendlyError(err: unknown): string {
  const e = err as { code?: string; message?: string };
  if (e?.code === 'no_openai_key')
    return 'Abe needs an OpenAI key to do this — add one in Settings.';
  return e?.message || 'Something went wrong. Please try again.';
}

// ── Inline spinner ────────────────────────────────────────────────────────────
function Spinner() {
  return <Loader2 size={14} className="animate-spin inline-block" />;
}

// ── Window options for breakdown ──────────────────────────────────────────────
const WINDOWS = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Panel 1: First-run / Guided setup (shown when categories === [])
// ═══════════════════════════════════════════════════════════════════════════════
function FirstRunCard({
  onSaved,
}: {
  onSaved: (cats: string[]) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggested, setSuggested] = useState<string[] | null>(null);
  const [editing, setEditing] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [retagging, setRetagging] = useState(false);

  async function handleAutoSetup() {
    setBusy(true);
    try {
      const res = await autoSetupCategories();
      if (res.applied) {
        toast.success(`Abe set up ${res.categories.length} categories and sorted ${res.tagged} calls.`);
        onSaved(res.categories);
      } else {
        toast.error('Abe needs some calls first — import past calls, then try again.');
      }
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSuggest() {
    setSuggesting(true);
    try {
      const r = await suggestCategories();
      setSuggested(r.suggested);
      setEditing(r.suggested);
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setSuggesting(false);
    }
  }

  async function handleSave() {
    const cats = editing.map(c => c.trim()).filter(Boolean);
    if (!cats.length) { toast.error('Add at least one category before saving.'); return; }
    setSaving(true);
    try {
      await putCategories(cats);
      toast.success('Categories saved — now sorting your calls…');
      setRetagging(true);
      try {
        const r = await retagCalls();
        const msg = r.remaining > 0
          ? `Sorted ${r.retagged} calls — the rest finish automatically shortly.`
          : `Sorted ${r.retagged} calls.`;
        toast.success(msg);
      } catch (err) {
        toast.error(friendlyError(err));
      } finally {
        setRetagging(false);
      }
      onSaved(cats);
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setSaving(false);
    }
  }

  if (!suggested) {
    return (
      <Card className="text-center space-y-4 py-8">
        <Phone size={40} className="mx-auto text-accent opacity-70" />
        <p className="text-ink font-medium text-base">
          Let's see what your callers are calling about
        </p>
        <p className="text-ink-muted text-sm max-w-sm mx-auto">
          Abe can read your recent calls, set up categories, and sort your calls — all in one click.
        </p>
        <div className="flex flex-col items-center gap-3">
          <Button onClick={handleAutoSetup} disabled={busy || suggesting}>
            {busy ? <><Spinner /> &nbsp;Abe is reading your calls…</> : 'Let Abe set them up for me'}
          </Button>
          <Button variant="ghost" onClick={handleSuggest} disabled={busy || suggesting}>
            {suggesting ? <><Spinner /> &nbsp;Abe is thinking…</> : "I'll set them up myself"}
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="space-y-4">
      <p className="text-ink font-medium">Abe's suggested categories — edit or add more, then save.</p>
      <CategoryEditor categories={editing} onChange={setEditing} />
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" onClick={() => setSuggested(null)}>Back</Button>
        <Button onClick={handleSave} disabled={saving || retagging}>
          {saving || retagging ? <><Spinner /> &nbsp;{retagging ? 'Sorting calls…' : 'Saving…'}</> : 'Save & sort calls'}
        </Button>
      </div>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Shared: inline category editor (add/remove rows)
// ═══════════════════════════════════════════════════════════════════════════════
function CategoryEditor({
  categories,
  onChange,
}: {
  categories: string[];
  onChange: (cats: string[]) => void;
}) {
  function update(idx: number, val: string) {
    const next = [...categories];
    next[idx] = val;
    onChange(next);
  }
  function remove(idx: number) {
    onChange(categories.filter((_, i) => i !== idx));
  }
  function add() {
    onChange([...categories, '']);
  }

  return (
    <div className="space-y-2">
      {categories.map((cat, i) => (
        <div key={i} className="flex gap-2 items-center">
          <label className="sr-only">Category {i + 1}</label>
          <Input
            value={cat}
            placeholder={`Category ${i + 1}`}
            onChange={e => update(i, e.target.value)}
            aria-label={`Category ${i + 1}`}
          />
          <button
            type="button"
            aria-label="Remove category"
            onClick={() => remove(i)}
            className="text-ink-dim hover:text-red-400 transition"
          >
            <Trash2 size={16} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="flex items-center gap-1 text-sm text-accent hover:underline"
      >
        <Plus size={14} /> Add category
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Panel 2: Breakdown (multi-dimension dashboard)
// ═══════════════════════════════════════════════════════════════════════════════

/** Normalise a possibly-null key to a display label */
function labelKey(key: string | null, fallback = 'Unknown'): string {
  return key ?? fallback;
}

/** Reusable ranked bar-row list */
function BarList({
  title,
  rows,
  total,
  labelFallback = 'Unknown',
}: {
  title: string;
  rows: Array<{ key: string | null; count: number }>;
  total: number;
  labelFallback?: string;
}) {
  if (!rows.length) return null;
  return (
    <div>
      <p className="text-xs font-medium text-ink-muted mb-2 uppercase tracking-wide">{title}</p>
      <Table>
        <thead>
          <tr>
            <Th>{title}</Th>
            <Th>Calls</Th>
            <Th>Share</Th>
            <Th>Bar</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const pct = total > 0 ? Math.round((row.count / total) * 100) : 0;
            return (
              <tr key={`${row.key}-${i}`}>
                <Td>{labelKey(row.key, labelFallback)}</Td>
                <Td>{row.count}</Td>
                <Td>{pct}%</Td>
                <Td>
                  <div className="w-32 bg-surface-raised rounded-full h-2" aria-hidden>
                    <div className="bg-accent h-2 rounded-full" style={{ width: `${pct}%` }} />
                  </div>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}

function BreakdownPanel({ ingestOn, reloadKey }: { ingestOn: boolean; reloadKey: number }) {
  const toast = useToast();
  const [win, setWin] = useState<'today' | '7d' | '30d'>('7d');
  const [data, setData] = useState<CallBreakdown | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(w: 'today' | '7d' | '30d') {
    setLoading(true);
    setError(null);
    try {
      const r = await getCallBreakdown(w);
      setData(r);
    } catch (err) {
      const msg = friendlyError(err);
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(win); }, [win, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card className="space-y-4">
      {/* Header + window toggle */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-base font-semibold text-ink">Call breakdown</h2>
        <div className="flex gap-1" role="group" aria-label="Time window">
          {WINDOWS.map(w => (
            <button
              key={w.value}
              onClick={() => setWin(w.value as 'today' | '7d' | '30d')}
              aria-pressed={win === w.value}
              className={`px-3 py-1 rounded-btn text-sm border transition ${
                win === w.value
                  ? 'bg-accent text-white border-accent'
                  : 'border-line text-ink-muted hover:text-ink hover:border-accent/60'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-8" />)}
        </div>
      ) : error ? (
        <div className="text-red-400 text-sm space-y-2">
          <p>{error}</p>
          <Button variant="ghost" onClick={() => load(win)}>Try again</Button>
        </div>
      ) : !data || data.summary.total === 0 ? (
        <EmptyState
          icon={Phone}
          title="No calls yet"
          description={
            ingestOn
              ? "They'll show up here as you send call summaries — or use Import past calls to bring in earlier ones."
              : "Turn on 'This is a call line' so Abe analyses the summaries you send."
          }
        />
      ) : (
        <div className="space-y-6">
          {/* 1. Metric cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {[
              { label: 'Total calls', value: String(data.summary.total) },
              { label: 'Resolution rate', value: `${data.summary.resolutionRatePct}%` },
              { label: 'FCR', value: String(data.summary.fcrCount) },
              { label: 'Callbacks', value: String(data.summary.callbackCount) },
              { label: 'Escalations', value: String(data.summary.escalationCount) },
              // Avg duration is only shown when the call source actually provides durations
              // (Jobix voice). Overflow/summary-only lines have none, so we hide the dead card.
              ...(data.summary.avgDurationSeconds
                ? [{ label: 'Avg duration', value: fmtDuration(data.summary.avgDurationSeconds) }]
                : []),
            ].map(({ label, value }) => (
              <div key={label} className="rounded-card border border-line bg-surface-raised px-4 py-3 space-y-1">
                <p className="text-xs text-ink-muted uppercase tracking-wide">{label}</p>
                <p className="text-xl font-semibold text-ink">{value}</p>
              </div>
            ))}
          </div>

          {/* 2. Who & why (crosstab) */}
          {data.crosstab.length > 0 && (() => {
            // Group rows by attribution_label, sort departments by total desc
            const map = new Map<string, Array<{ category: string; count: number }>>();
            for (const row of data.crosstab) {
              const dept = labelKey(row.attribution_label, 'Unattributed');
              const cat = labelKey(row.category, 'Uncategorised');
              if (!map.has(dept)) map.set(dept, []);
              map.get(dept)!.push({ category: cat, count: row.count });
            }
            // Sort departments by sum of counts desc
            const depts = Array.from(map.entries())
              .map(([dept, cats]) => ({ dept, cats: cats.sort((a, b) => b.count - a.count), total: cats.reduce((s, c) => s + c.count, 0) }))
              .sort((a, b) => b.total - a.total);
            return (
              <div>
                <p className="text-xs font-medium text-ink-muted mb-2 uppercase tracking-wide">Who &amp; why</p>
                <div className="space-y-3">
                  {depts.map(({ dept, cats, total: deptTotal }) => (
                    <div key={dept}>
                      <p className="text-sm font-medium text-ink mb-1">{dept} <span className="text-ink-muted font-normal">({deptTotal})</span></p>
                      <div className="pl-3 space-y-1">
                        {cats.map(({ category, count }) => {
                          const pct = deptTotal > 0 ? Math.round((count / deptTotal) * 100) : 0;
                          return (
                            <div key={category} className="flex items-center gap-3 text-sm">
                              <span className="w-36 shrink-0 text-ink-muted truncate">{category}</span>
                              <div className="flex-1 bg-surface-raised rounded-full h-1.5">
                                <div className="bg-accent/70 h-1.5 rounded-full" style={{ width: `${pct}%` }} />
                              </div>
                              <span className="w-8 text-right text-ink">{count}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* 3. Mini-breakdowns */}
          <BarList title="By Department" rows={data.byDepartment} total={data.summary.total} labelFallback="Unknown" />
          <BarList title="By Outcome" rows={data.byOutcome} total={data.summary.total} labelFallback="Unknown" />
          <BarList title="By Sentiment" rows={data.bySentiment} total={data.summary.total} labelFallback="Unknown" />
          <BarList title="By Resolution" rows={data.byResolution} total={data.summary.total} labelFallback="Unknown" />

          {/* 4. Per-day trend */}
          {data.perDay.length > 0 && (
            <div>
              <p className="text-xs font-medium text-ink-muted mb-2 uppercase tracking-wide">Per day</p>
              <div className="space-y-1">
                {data.perDay.map(d => (
                  <div key={d.day} className="flex items-center gap-3 text-sm">
                    <span className="w-24 shrink-0 text-ink-muted">{d.day}</span>
                    <div className="flex-1 bg-surface-raised rounded-full h-1.5">
                      <div
                        className="bg-magenta/70 h-1.5 rounded-full"
                        style={{
                          width: `${Math.round(
                            (d.count / Math.max(...data.perDay.map(x => x.count), 1)) * 100,
                          )}%`,
                        }}
                      />
                    </div>
                    <span className="w-8 text-right text-ink">{d.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Panel 3: Categories management
// ═══════════════════════════════════════════════════════════════════════════════
function CategoriesPanel({ categories, onUpdated }: { categories: string[]; onUpdated: (cats: string[]) => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState<string[]>(categories);
  const [saving, setSaving] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestResult, setSuggestResult] = useState<string[] | null>(null);
  const [retagging, setRetagging] = useState(false);
  const [confirmRetag, setConfirmRetag] = useState(false);

  // sync if parent refreshes
  useEffect(() => { setEditing(categories); }, [categories]);

  async function handleSave() {
    const cats = editing.map(c => c.trim()).filter(Boolean);
    if (!cats.length) { toast.error('Add at least one category.'); return; }
    setSaving(true);
    try {
      const r = await putCategories(cats);
      onUpdated(r.categories);
      toast.success('Categories saved.');
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleSuggest() {
    setSuggesting(true);
    try {
      const r = await suggestCategories();
      setSuggestResult(r.suggested);
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setSuggesting(false);
    }
  }

  function applySuggested() {
    if (!suggestResult) return;
    // merge: keep existing not in suggested, plus all suggested
    const merged = Array.from(new Set([...editing, ...suggestResult]));
    setEditing(merged);
    setSuggestResult(null);
    toast.success('Suggestions added — review and save when ready.');
  }

  async function handleRetag() {
    setConfirmRetag(false);
    setRetagging(true);
    toast.success('Sorting your calls…');
    try {
      const r = await retagCalls();
      const msg = r.remaining > 0
        ? `Sorted ${r.retagged} calls — the rest finish automatically shortly.`
        : `Sorted ${r.retagged} calls.`;
      toast.success(msg);
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setRetagging(false);
    }
  }

  const busy = saving || suggesting || retagging;

  return (
    <Card className="space-y-4">
      <h2 className="text-base font-semibold text-ink">Categories</h2>
      <CategoryEditor categories={editing} onChange={setEditing} />

      <div className="flex flex-wrap gap-2 justify-end pt-2">
        <Button
          variant="ghost"
          onClick={handleSuggest}
          disabled={busy}
          aria-label="Let Abe suggest categories"
        >
          {suggesting ? <><Spinner /> &nbsp;Asking Abe…</> : 'Let Abe suggest'}
        </Button>
        <Button onClick={handleSave} disabled={busy}>
          {saving ? <><Spinner /> &nbsp;Saving…</> : 'Save'}
        </Button>
        <Button
          variant="ghost"
          onClick={() => setConfirmRetag(true)}
          disabled={busy}
          aria-label="Re-sort all calls into current categories"
        >
          {retagging ? <><Spinner /> &nbsp;Sorting…</> : 'Re-sort all calls'}
        </Button>
      </div>

      {/* Confirm re-tag */}
      <Modal open={confirmRetag} onClose={() => setConfirmRetag(false)} title="Re-sort all calls">
        <div className="space-y-4">
          <p className="text-sm text-ink-muted">
            This will re-sort every call into your current categories. It may take a moment.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmRetag(false)}>Cancel</Button>
            <Button onClick={handleRetag}>Yes, re-sort</Button>
          </div>
        </div>
      </Modal>

      {/* Suggested categories review */}
      <Modal
        open={!!suggestResult}
        onClose={() => setSuggestResult(null)}
        title="Abe's suggested categories"
      >
        <div className="space-y-4">
          <p className="text-sm text-ink-muted">
            These are Abe's suggestions based on your calls. You can merge them into your list or replace it.
          </p>
          {suggestResult && (
            <ul className="space-y-1">
              {suggestResult.map((c, i) => (
                <li key={i} className="text-sm text-ink bg-surface-raised rounded px-3 py-1.5">{c}</li>
              ))}
            </ul>
          )}
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setSuggestResult(null)}>Dismiss</Button>
            <Button variant="ghost" onClick={() => { setEditing(suggestResult ?? []); setSuggestResult(null); toast.success('Categories replaced — save when ready.'); }}>
              Replace
            </Button>
            <Button onClick={applySuggested}>Merge into list</Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Panel 4: Call explorer
// ═══════════════════════════════════════════════════════════════════════════════
const PAGE_SIZE = 50;

// ── Sort config ───────────────────────────────────────────────────────────────
type SortField = NonNullable<CallFilters['sort']>;

interface SortableCol {
  label: string;
  field: SortField;
}

const SORTABLE_COLS: SortableCol[] = [
  { label: 'Time',       field: 'created_at' },
  { label: 'Department', field: 'attribution_label' },
  { label: 'Category',   field: 'category' },
  { label: 'Outcome',    field: 'call_outcome' },
  { label: 'Sentiment',  field: 'sentiment' },
  { label: 'Duration',   field: 'call_duration_seconds' },
  { label: 'Resolution', field: 'resolution_state' },
];

// ── Resolution options ────────────────────────────────────────────────────────
const RESOLUTION_OPTIONS = ['open', 'in_progress', 'resolved', 'unresolved'];

// ── Sortable header cell ──────────────────────────────────────────────────────
function SortTh({
  col,
  sort,
  sortDir,
  onSort,
  children,
}: {
  col: SortField;
  sort: SortField | undefined;
  sortDir: 'asc' | 'desc';
  onSort: (col: SortField) => void;
  children: ReactNode;
}) {
  const active = sort === col;
  return (
    <Th>
      <button
        type="button"
        onClick={() => onSort(col)}
        className={`flex items-center gap-1 whitespace-nowrap hover:text-accent transition ${active ? 'text-accent' : ''}`}
        aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        {children}
        {active ? (
          <span className="text-xs">{sortDir === 'asc' ? '▲' : '▼'}</span>
        ) : (
          <span className="text-xs opacity-30">▼</span>
        )}
      </button>
    </Th>
  );
}

// ── select helper ─────────────────────────────────────────────────────────────
const SELECT_CLS = 'rounded-btn border border-line bg-surface-raised text-ink px-3 py-2 text-sm focus:outline-none focus:border-accent';

function ExplorerPanel({ categories }: { categories: string[] }) {
  const toast = useToast();

  // ── filter state ─────────────────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [attribution, setAttribution] = useState('');
  const [outcome, setOutcome] = useState('');
  const [sentiment, setSentiment] = useState('');
  const [resolution, setResolution] = useState('');
  const [callbackRequested, setCallbackRequested] = useState<boolean | undefined>(undefined);
  const [escalationRequested, setEscalationRequested] = useState<boolean | undefined>(undefined);
  const [sort, setSort] = useState<SortField | undefined>(undefined);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  // ── pagination + data state ───────────────────────────────────────────────────
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<CallRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<CallRow | null>(null);

  // ── derived option lists from loaded rows ─────────────────────────────────────
  const deptOptions = Array.from(new Set(items.map(r => r.attribution_label).filter(Boolean))) as string[];
  const outcomeOptions = Array.from(new Set(items.map(r => r.call_outcome).filter(Boolean))) as string[];
  const sentimentOptions = Array.from(new Set(items.map(r => r.sentiment).filter(Boolean))) as string[];

  // ── build filters object ──────────────────────────────────────────────────────
  function buildFilters(off: number): CallFilters {
    const f: CallFilters = { limit: PAGE_SIZE, offset: off };
    if (search)      f.search     = search;
    if (category)    f.category   = category;
    if (from)        f.from       = from;
    if (to)          f.to         = to;
    if (attribution) f.attribution = attribution;
    if (outcome)     f.outcome    = outcome;
    if (sentiment)   f.sentiment  = sentiment;
    if (resolution)  f.resolution = resolution;
    if (callbackRequested  !== undefined) f.callbackRequested  = callbackRequested;
    if (escalationRequested !== undefined) f.escalationRequested = escalationRequested;
    if (sort)        f.sort       = sort;
    if (sort)        f.sortDir    = sortDir;
    return f;
  }

  async function load(off: number) {
    setLoading(true);
    try {
      const r = await listCalls(buildFilters(off));
      setItems(r.calls);
      setTotal(r.total);
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setLoading(false);
    }
  }

  // ── refetch on any filter or sort change ──────────────────────────────────────
  useEffect(() => {
    setOffset(0);
    load(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, category, from, to, attribution, outcome, sentiment, resolution,
      callbackRequested, escalationRequested, sort, sortDir]);

  function goPage(newOff: number) {
    setOffset(newOff);
    load(newOff);
  }

  function handleSort(col: SortField) {
    if (sort === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSort(col);
      setSortDir('desc');
    }
  }

  const start = offset + 1;
  const end = Math.min(offset + PAGE_SIZE, total);
  const csvUrl = exportCallsCsvUrl(buildFilters(offset));

  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-base font-semibold text-ink">Call explorer</h2>
        <a
          href={csvUrl}
          download
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-btn border border-line bg-surface-raised text-ink text-sm hover:border-accent/60 hover:text-accent transition"
          aria-label="Export calls as CSV"
        >
          <Download size={14} /> Export CSV
        </a>
      </div>

      {/* Filters row 1: search + category + dates */}
      <div className="flex flex-wrap gap-3">
        <div className="flex-1 min-w-[200px]">
          <label className="sr-only">Search what callers said</label>
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search what callers said…"
            aria-label="Search what callers said"
          />
        </div>
        <div>
          <label className="sr-only">Filter by category</label>
          <select
            className={SELECT_CLS}
            value={category}
            onChange={e => setCategory(e.target.value)}
            aria-label="Filter by category"
          >
            <option value="">All categories</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className="sr-only">From date</label>
          <input
            type="date"
            className={SELECT_CLS}
            value={from}
            onChange={e => setFrom(e.target.value)}
            aria-label="From date"
          />
        </div>
        <div>
          <label className="sr-only">To date</label>
          <input
            type="date"
            className={SELECT_CLS}
            value={to}
            onChange={e => setTo(e.target.value)}
            aria-label="To date"
          />
        </div>
      </div>

      {/* Filters row 2: department + outcome + sentiment + resolution + checkboxes */}
      <div className="flex flex-wrap gap-3 items-center">
        <div>
          <label className="sr-only">Filter by department</label>
          <select
            className={SELECT_CLS}
            value={attribution}
            onChange={e => setAttribution(e.target.value)}
            aria-label="Filter by department"
          >
            <option value="">Any department</option>
            {deptOptions.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div>
          <label className="sr-only">Filter by outcome</label>
          <select
            className={SELECT_CLS}
            value={outcome}
            onChange={e => setOutcome(e.target.value)}
            aria-label="Filter by outcome"
          >
            <option value="">Any outcome</option>
            {outcomeOptions.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <div>
          <label className="sr-only">Filter by sentiment</label>
          <select
            className={SELECT_CLS}
            value={sentiment}
            onChange={e => setSentiment(e.target.value)}
            aria-label="Filter by sentiment"
          >
            <option value="">Any sentiment</option>
            {sentimentOptions.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="sr-only">Filter by resolution</label>
          <select
            className={SELECT_CLS}
            value={resolution}
            onChange={e => setResolution(e.target.value)}
            aria-label="Filter by resolution"
          >
            <option value="">Any resolution</option>
            {RESOLUTION_OPTIONS.map(r => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink cursor-pointer select-none">
          <input
            type="checkbox"
            checked={callbackRequested === true}
            onChange={e => setCallbackRequested(e.target.checked ? true : undefined)}
            className="h-4 w-4 rounded border-line accent-magenta"
            aria-label="Callback requested"
          />
          Callback
        </label>
        <label className="flex items-center gap-2 text-sm text-ink cursor-pointer select-none">
          <input
            type="checkbox"
            checked={escalationRequested === true}
            onChange={e => setEscalationRequested(e.target.checked ? true : undefined)}
            className="h-4 w-4 rounded border-line accent-magenta"
            aria-label="Escalation requested"
          />
          Escalation
        </label>
      </div>

      {/* Results */}
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-9" />)}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Phone}
          title="No calls match"
          description="Try a different search or filter."
        />
      ) : (
        <>
          {/* Desktop table — horizontally scrollable */}
          <div className="hidden md:block overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <SortTh col="created_at"           sort={sort} sortDir={sortDir} onSort={handleSort}>Time</SortTh>
                  <Th>Caller</Th>
                  <SortTh col="attribution_label"    sort={sort} sortDir={sortDir} onSort={handleSort}>Department</SortTh>
                  <Th>Type</Th>
                  <SortTh col="category"             sort={sort} sortDir={sortDir} onSort={handleSort}>Category</SortTh>
                  <SortTh col="call_outcome"         sort={sort} sortDir={sortDir} onSort={handleSort}>Outcome</SortTh>
                  <SortTh col="sentiment"            sort={sort} sortDir={sortDir} onSort={handleSort}>Sentiment</SortTh>
                  {items.some(c => (c.call_duration_seconds ?? 0) > 0)
                    ? <SortTh col="call_duration_seconds" sort={sort} sortDir={sortDir} onSort={handleSort}>Duration</SortTh>
                    : null}
                  <Th>Callback</Th>
                  <Th>Escalation</Th>
                  <SortTh col="resolution_state"    sort={sort} sortDir={sortDir} onSort={handleSort}>Resolution</SortTh>
                  <Th>Excerpt</Th>
                </tr>
              </thead>
              <tbody>
                {items.map(call => (
                  <tr
                    key={call.id}
                    className="cursor-pointer hover:bg-surface"
                    onClick={() => setSel(call)}
                    tabIndex={0}
                    onKeyDown={e => e.key === 'Enter' && setSel(call)}
                    aria-label={`Open call from ${new Date(call.created_at).toLocaleDateString()}`}
                  >
                    <Td className="text-ink-dim whitespace-nowrap text-xs">
                      {new Date(call.created_at).toLocaleString()}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {call.caller_name || call.caller_phone ? (
                        <div className="flex flex-col">
                          {call.caller_name && <span className="text-sm text-ink">{call.caller_name}</span>}
                          {call.caller_phone && <span className="text-xs text-ink-muted">{call.caller_phone}</span>}
                        </div>
                      ) : (
                        <span className="text-ink-dim text-xs">—</span>
                      )}
                    </Td>
                    <Td className="text-sm whitespace-nowrap">
                      {call.attribution_label ?? <span className="text-ink-dim text-xs">—</span>}
                    </Td>
                    <Td className="text-sm whitespace-nowrap">
                      {call.call_type ?? <span className="text-ink-dim text-xs">—</span>}
                    </Td>
                    <Td>
                      {call.category ? (
                        <span className="bg-accent/15 text-accent text-xs px-2 py-0.5 rounded-full whitespace-nowrap">{call.category}</span>
                      ) : (
                        <span className="text-ink-dim text-xs">—</span>
                      )}
                    </Td>
                    <Td className="text-sm whitespace-nowrap">
                      {call.call_outcome ?? <span className="text-ink-dim text-xs">—</span>}
                    </Td>
                    <Td><SentimentChip sentiment={call.sentiment} /></Td>
                    {items.some(c => (c.call_duration_seconds ?? 0) > 0)
                      ? <Td className="text-sm whitespace-nowrap">{fmtDuration(call.call_duration_seconds)}</Td>
                      : null}
                    <Td className="text-center text-sm">
                      {call.callback_requested === true ? '✓' : call.callback_requested === false ? '—' : <span className="text-ink-dim text-xs">—</span>}
                    </Td>
                    <Td className="text-center text-sm">
                      {call.escalation_requested === true ? '✓' : call.escalation_requested === false ? '—' : <span className="text-ink-dim text-xs">—</span>}
                    </Td>
                    <Td><ResolutionChip state={call.resolution_state} /></Td>
                    <Td className="text-ink-muted text-sm max-w-xs truncate">
                      {call.content.slice(0, 120)}{call.content.length > 120 ? '…' : ''}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-3">
            {items.map(call => (
              <button
                key={call.id}
                className="w-full text-left bg-surface-raised border border-line rounded-xl p-4 space-y-1.5 hover:border-accent/50 transition focus:outline-none focus:ring-2 focus:ring-accent"
                onClick={() => setSel(call)}
                aria-label={`Open call from ${new Date(call.created_at).toLocaleDateString()}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-ink-dim">{new Date(call.created_at).toLocaleString()}</span>
                  {call.attribution_label && (
                    <span className="text-xs text-ink-muted">{call.attribution_label}</span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {call.category && (
                    <span className="bg-accent/15 text-accent text-xs px-2 py-0.5 rounded-full">{call.category}</span>
                  )}
                  {call.call_outcome && (
                    <span className="text-xs text-ink-muted">{call.call_outcome}</span>
                  )}
                  <ResolutionChip state={call.resolution_state} />
                </div>
                <p className="text-sm text-ink-muted line-clamp-2">{call.content}</p>
              </button>
            ))}
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between text-sm text-ink-muted pt-1">
            <span>{start}–{end} of {total}</span>
            <div className="flex gap-1">
              <button
                aria-label="Previous page"
                disabled={offset === 0}
                onClick={() => goPage(Math.max(0, offset - PAGE_SIZE))}
                className="p-1 rounded hover:bg-surface disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronLeft size={16} />
              </button>
              <button
                aria-label="Next page"
                disabled={end >= total}
                onClick={() => goPage(offset + PAGE_SIZE)}
                className="p-1 rounded hover:bg-surface disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        </>
      )}

      {/* Call detail modal */}
      <Modal open={!!sel} onClose={() => setSel(null)} title="Call detail">
        {sel && (
          <div className="space-y-4 text-sm">
            {/* Caller */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-2">
              <div>
                <span className="text-ink-muted block text-xs mb-0.5">Caller name</span>
                <span className="text-ink">{sel.caller_name ?? '—'}</span>
              </div>
              <div>
                <span className="text-ink-muted block text-xs mb-0.5">Caller phone</span>
                <span className="text-ink">{sel.caller_phone ?? '—'}</span>
              </div>
              <div>
                <span className="text-ink-muted block text-xs mb-0.5">Department</span>
                <span className="text-ink">{sel.attribution_label ?? '—'}</span>
              </div>
              <div>
                <span className="text-ink-muted block text-xs mb-0.5">Type</span>
                <span className="text-ink">{sel.call_type ?? '—'}</span>
              </div>
              <div>
                <span className="text-ink-muted block text-xs mb-0.5">Outcome</span>
                <span className="text-ink">{sel.call_outcome ?? '—'}</span>
              </div>
              <div>
                <span className="text-ink-muted block text-xs mb-0.5">Sentiment</span>
                <SentimentChip sentiment={sel.sentiment} />
              </div>
              <div>
                <span className="text-ink-muted block text-xs mb-0.5">Duration</span>
                <span className="text-ink">{fmtDuration(sel.call_duration_seconds)}</span>
              </div>
              <div>
                <span className="text-ink-muted block text-xs mb-0.5">Resolution</span>
                <ResolutionChip state={sel.resolution_state} />
              </div>
              <div>
                <span className="text-ink-muted block text-xs mb-0.5">Callback requested</span>
                <span className="text-ink">{sel.callback_requested === true ? 'Yes' : sel.callback_requested === false ? 'No' : '—'}</span>
              </div>
              <div>
                <span className="text-ink-muted block text-xs mb-0.5">Escalation requested</span>
                <span className="text-ink">{sel.escalation_requested === true ? 'Yes' : sel.escalation_requested === false ? 'No' : '—'}</span>
              </div>
              <div>
                <span className="text-ink-muted block text-xs mb-0.5">Category</span>
                {sel.category
                  ? <span className="bg-accent/15 text-accent text-xs px-2 py-0.5 rounded-full">{sel.category}</span>
                  : <span className="text-ink-dim text-xs">—</span>}
              </div>
              <div>
                <span className="text-ink-muted block text-xs mb-0.5">Severity</span>
                <SeverityChip severity={sel.severity} />
              </div>
              <div className="col-span-2">
                <span className="text-ink-muted block text-xs mb-0.5">Time</span>
                <span className="text-ink">{new Date(sel.created_at).toLocaleString()}</span>
              </div>
            </div>
            <hr className="border-line" />
            <div>
              <span className="text-ink-muted block text-xs mb-1">Summary</span>
              <pre className="whitespace-pre-wrap text-ink bg-surface-raised rounded-lg p-4 text-sm max-h-96 overflow-y-auto">{sel.content}</pre>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
}

function SeverityChip({ severity }: { severity: string | null }) {
  if (!severity) return <span className="text-ink-dim text-xs">—</span>;
  const colour =
    severity === 'high' ? 'bg-red-500/15 text-red-400' :
    severity === 'medium' ? 'bg-yellow-500/15 text-yellow-400' :
    'bg-green-500/15 text-green-400';
  return <span className={`text-xs px-2 py-0.5 rounded-full ${colour}`}>{severity}</span>;
}

/** Format call_duration_seconds → "m:ss" or "—" */
function fmtDuration(s: number | null): string {
  if (s === null || s === undefined) return '—';
  const mins = Math.floor(s / 60);
  const secs = String(s % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}

function SentimentChip({ sentiment }: { sentiment: string | null }) {
  if (!sentiment) return <span className="text-ink-dim text-xs">—</span>;
  const colour =
    sentiment === 'positive' ? 'bg-green-500/15 text-green-400' :
    sentiment === 'negative' ? 'bg-red-500/15 text-red-400' :
    'bg-surface-raised text-ink-muted';
  return <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${colour}`}>{sentiment}</span>;
}

function ResolutionChip({ state }: { state: string | null }) {
  if (!state) return <span className="text-ink-dim text-xs">—</span>;
  const colour =
    state === 'resolved'    ? 'bg-green-500/15 text-green-400' :
    state === 'in_progress' ? 'bg-blue-500/15 text-blue-400' :
    state === 'unresolved'  ? 'bg-yellow-500/15 text-yellow-400' :
    'bg-surface-raised text-ink-muted'; // open
  const label = state.replace('_', ' ');
  return <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${colour}`}>{label}</span>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Panel 5: Ask Abe
// ═══════════════════════════════════════════════════════════════════════════════
function AskAbePanel() {
  const toast = useToast();
  const [input, setInput] = useState('');
  const [reply, setReply] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleAsk() {
    const msg = input.trim();
    if (!msg || loading) return;
    setLoading(true);
    setReply(null);
    try {
      const r = await api<{ reply: string }>('/api/agent/chat', {
        method: 'POST',
        body: JSON.stringify({ message: msg }),
      });
      setReply(r.reply);
    } catch (err) {
      toast.error(friendlyError(err));
      // keep input so user can retry
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') handleAsk();
  }

  return (
    <Card className="space-y-4">
      <div className="flex items-center gap-2">
        <Bot size={18} className="text-accent" />
        <h2 className="text-base font-semibold text-ink">Ask Abe</h2>
      </div>
      <div className="flex gap-2">
        <label className="sr-only">Ask Abe a question about your calls</label>
        <Input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Try: how many claims last week?"
          disabled={loading}
          aria-label="Ask Abe a question about your calls"
        />
        <Button onClick={handleAsk} disabled={loading || !input.trim()}>
          {loading ? <Spinner /> : 'Ask'}
        </Button>
      </div>
      {loading && (
        <p className="text-sm text-ink-muted flex items-center gap-2">
          <Spinner /> Abe is looking…
        </p>
      )}
      {reply && !loading && (
        <div className="bg-surface-raised border border-line rounded-xl p-4 text-sm text-ink whitespace-pre-wrap">
          {reply}
        </div>
      )}
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Panel 0: Call-line settings (toggle + import past calls)
// ═══════════════════════════════════════════════════════════════════════════════
function CallLineSettingsPanel({
  ingestOn,
  onIngestChange,
  onImported,
}: {
  ingestOn: boolean;
  onIngestChange: (v: boolean) => void;
  onImported: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);

  async function handleToggle(next: boolean) {
    if (saving) return;
    const prev = ingestOn;
    onIngestChange(next); // optimistic
    setSaving(true);
    try {
      const r = await putCallSettings(next);
      onIngestChange(r.ingestSendsAsCalls);
      toast.success(r.ingestSendsAsCalls ? 'Call line turned on.' : 'Call line turned off.');
    } catch (err) {
      onIngestChange(prev); // restore prior state on failure
      toast.error(friendlyError(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleImport() {
    if (importing) return;
    setImporting(true);
    try {
      const r = await importPastCalls();
      toast.success(`Imported ${r.imported} past calls`);
      onImported();
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setImporting(false);
    }
  }

  return (
    <Card className="space-y-4">
      <h2 className="text-base font-semibold text-ink">Call line</h2>

      <label className="flex items-start gap-3 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={ingestOn}
          disabled={saving}
          onChange={e => handleToggle(e.target.checked)}
          className="h-4 w-4 mt-0.5 rounded border-line-strong accent-magenta disabled:opacity-50"
          aria-label="This is a call line"
        />
        <span className="space-y-1">
          <span className="flex items-center gap-2 text-sm font-medium text-ink">
            This is a call line
            {saving && <Spinner />}
          </span>
          <span className="block text-sm text-ink-muted">
            Abe treats the call summaries you send as calls and analyses them here.
          </span>
        </span>
      </label>

      {ingestOn && (
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button variant="secondary" onClick={handleImport} disabled={importing}>
            {importing
              ? <><Spinner /> &nbsp;Importing…</>
              : <><Download size={14} /> Import past calls</>}
          </Button>
          <span className="text-xs text-ink-muted">
            Brings your earlier sent summaries into the breakdown.
          </span>
        </div>
      )}
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main page
// ═══════════════════════════════════════════════════════════════════════════════
export default function Calls() {
  const { user, loading: authLoading } = useAuth();
  const toast = useToast();

  const [catLoading, setCatLoading] = useState(true);
  const [categories, setCategories] = useState<string[] | null>(null);
  const [catError, setCatError] = useState<string | null>(null);

  const [ingestOn, setIngestOn] = useState(false);
  const [breakdownKey, setBreakdownKey] = useState(0);

  const isAdmin = !authLoading && (user?.role === 'tenant_admin' || user?.role === 'super_admin');

  async function loadCategories() {
    setCatLoading(true);
    setCatError(null);
    try {
      const r = await getCategories();
      setCategories(r.categories);
    } catch (err) {
      const msg = friendlyError(err);
      setCatError(msg);
      toast.error(msg);
      setCategories([]);
    } finally {
      setCatLoading(false);
    }
  }

  async function loadSettings() {
    try {
      const r = await getCallSettings();
      setIngestOn(r.ingestSendsAsCalls);
    } catch (err) {
      // Non-fatal: keep the page usable, surface as a toast.
      toast.error(friendlyError(err));
    }
  }

  useEffect(() => {
    if (!authLoading) { loadCategories(); loadSettings(); }
  }, [authLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  if (authLoading || catLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Calls" subtitle="See what your callers are calling about." />
        <div className="space-y-4">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="space-y-6">
        <PageHeader title="Calls" subtitle="See what your callers are calling about." />
        <Card>
          <p className="text-ink-muted text-sm">
            You need admin access to view call analytics. Ask your administrator.
          </p>
        </Card>
      </div>
    );
  }

  if (catError && categories === null) {
    return (
      <div className="space-y-6">
        <PageHeader title="Calls" subtitle="See what your callers are calling about." />
        <Card className="space-y-3">
          <p className="text-red-400 text-sm">{catError}</p>
          <Button variant="ghost" onClick={loadCategories}>Try again</Button>
        </Card>
      </div>
    );
  }

  // First-run: no categories configured yet
  if (categories !== null && categories.length === 0 && !catError) {
    return (
      <div className="space-y-6">
        <PageHeader title="Calls" subtitle="See what your callers are calling about." />
        <FirstRunCard onSaved={cats => setCategories(cats)} />
      </div>
    );
  }

  // Dashboard
  return (
    <div className="space-y-6">
      <PageHeader title="Calls" subtitle="See what your callers are calling about." />
      <CallLineSettingsPanel
        ingestOn={ingestOn}
        onIngestChange={setIngestOn}
        onImported={() => setBreakdownKey(k => k + 1)}
      />
      <BreakdownPanel ingestOn={ingestOn} reloadKey={breakdownKey} />
      <CategoriesPanel
        categories={categories ?? []}
        onUpdated={cats => setCategories(cats)}
      />
      <ExplorerPanel categories={categories ?? []} />
      <AskAbePanel />
    </div>
  );
}
