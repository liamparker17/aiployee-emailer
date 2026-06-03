import { useEffect, useState } from 'react';
import { Phone, ChevronLeft, ChevronRight, Plus, Trash2, Loader2, Bot } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import {
  listCalls,
  getBreakdown,
  getCategories,
  putCategories,
  suggestCategories,
  retagCalls,
} from '../lib/calls';
import type { Call, Breakdown } from '../lib/calls';
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
  const [suggesting, setSuggesting] = useState(false);
  const [suggested, setSuggested] = useState<string[] | null>(null);
  const [editing, setEditing] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [retagging, setRetagging] = useState(false);

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
          Abe can look at your recent calls and suggest categories automatically.
        </p>
        <Button onClick={handleSuggest} disabled={suggesting}>
          {suggesting ? <><Spinner /> &nbsp;Abe is thinking…</> : 'Let Abe suggest categories'}
        </Button>
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
// Panel 2: Breakdown
// ═══════════════════════════════════════════════════════════════════════════════
function BreakdownPanel() {
  const toast = useToast();
  const [win, setWin] = useState('7d');
  const [data, setData] = useState<Breakdown | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(w: string) {
    setLoading(true);
    setError(null);
    try {
      const r = await getBreakdown(w);
      setData(r);
    } catch (err) {
      const msg = friendlyError(err);
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(win); }, [win]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-base font-semibold text-ink">Call breakdown</h2>
        <div className="flex gap-1" role="group" aria-label="Time window">
          {WINDOWS.map(w => (
            <button
              key={w.value}
              onClick={() => setWin(w.value)}
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
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-8" />)}
        </div>
      ) : error ? (
        <div className="text-red-400 text-sm space-y-2">
          <p>{error}</p>
          <Button variant="ghost" onClick={() => load(win)}>Try again</Button>
        </div>
      ) : !data || data.total === 0 ? (
        <EmptyState
          icon={Phone}
          title="No calls yet"
          description="They'll show up here automatically as they come in."
        />
      ) : (
        <div className="space-y-4">
          <Table>
            <thead>
              <tr>
                <Th>Category</Th>
                <Th>Calls</Th>
                <Th>Share</Th>
                <Th>Bar</Th>
              </tr>
            </thead>
            <tbody>
              {data.byCategory.map(row => {
                const pct = Math.round((row.count / data.total) * 100);
                return (
                  <tr key={row.category}>
                    <Td>{row.category || 'Uncategorised'}</Td>
                    <Td>{row.count}</Td>
                    <Td>{pct}%</Td>
                    <Td>
                      <div className="w-32 bg-surface-raised rounded-full h-2" aria-hidden>
                        <div
                          className="bg-accent h-2 rounded-full"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>

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

function ExplorerPanel({ categories }: { categories: string[] }) {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<Call[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<Call | null>(null);

  async function load(off: number) {
    setLoading(true);
    try {
      const r = await listCalls({ search, category, from, to, limit: PAGE_SIZE, offset: off });
      setItems(r.calls);
      setTotal(r.total);
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setOffset(0);
    load(0);
  }, [search, category, from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  function goPage(newOff: number) {
    setOffset(newOff);
    load(newOff);
  }

  const start = offset + 1;
  const end = Math.min(offset + PAGE_SIZE, total);

  return (
    <Card className="space-y-4">
      <h2 className="text-base font-semibold text-ink">Call explorer</h2>

      {/* Filters */}
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
            className="rounded-btn border border-line bg-surface-raised text-ink px-3 py-2 text-sm focus:outline-none focus:border-accent"
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
            className="rounded-btn border border-line bg-surface-raised text-ink px-3 py-2 text-sm focus:outline-none focus:border-accent"
            value={from}
            onChange={e => setFrom(e.target.value)}
            aria-label="From date"
          />
        </div>
        <div>
          <label className="sr-only">To date</label>
          <input
            type="date"
            className="rounded-btn border border-line bg-surface-raised text-ink px-3 py-2 text-sm focus:outline-none focus:border-accent"
            value={to}
            onChange={e => setTo(e.target.value)}
            aria-label="To date"
          />
        </div>
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
          description="Try a different search or window."
        />
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block">
            <Table>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Category</Th>
                  <Th>Severity</Th>
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
                    <Td className="text-ink-dim whitespace-nowrap">{new Date(call.created_at).toLocaleString()}</Td>
                    <Td>
                      {call.category ? (
                        <span className="bg-accent/15 text-accent text-xs px-2 py-0.5 rounded-full">{call.category}</span>
                      ) : (
                        <span className="text-ink-dim text-xs">—</span>
                      )}
                    </Td>
                    <Td>
                      <SeverityChip severity={call.severity} />
                    </Td>
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
                className="w-full text-left bg-surface-raised border border-line rounded-xl p-4 space-y-1 hover:border-accent/50 transition focus:outline-none focus:ring-2 focus:ring-accent"
                onClick={() => setSel(call)}
                aria-label={`Open call from ${new Date(call.created_at).toLocaleDateString()}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-ink-dim">{new Date(call.created_at).toLocaleString()}</span>
                  {call.category && (
                    <span className="bg-accent/15 text-accent text-xs px-2 py-0.5 rounded-full">{call.category}</span>
                  )}
                </div>
                <SeverityChip severity={call.severity} />
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
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-4">
              <div><span className="text-ink-muted">Date: </span><span className="text-ink">{new Date(sel.created_at).toLocaleString()}</span></div>
              <div><span className="text-ink-muted">Category: </span><span className="text-ink">{sel.category ?? '—'}</span></div>
              <div><span className="text-ink-muted">Severity: </span><SeverityChip severity={sel.severity} /></div>
            </div>
            <hr className="border-line" />
            <pre className="whitespace-pre-wrap text-ink bg-surface-raised rounded-lg p-4 text-sm max-h-96 overflow-y-auto">{sel.content}</pre>
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
// Main page
// ═══════════════════════════════════════════════════════════════════════════════
export default function Calls() {
  const { user, loading: authLoading } = useAuth();
  const toast = useToast();

  const [catLoading, setCatLoading] = useState(true);
  const [categories, setCategories] = useState<string[] | null>(null);
  const [catError, setCatError] = useState<string | null>(null);

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

  useEffect(() => {
    if (!authLoading) loadCategories();
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
      <BreakdownPanel />
      <CategoriesPanel
        categories={categories ?? []}
        onUpdated={cats => setCategories(cats)}
      />
      <ExplorerPanel categories={categories ?? []} />
      <AskAbePanel />
    </div>
  );
}
