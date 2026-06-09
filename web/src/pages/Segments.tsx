import { useEffect, useState } from 'react';
import { Filter } from 'lucide-react';
import { api } from '@aiployee/ui';
import { Table, Th, Td } from '@aiployee/ui';
import { Button } from '@aiployee/ui';
import { Input, Field } from '@aiployee/ui';
import { Card } from '@aiployee/ui';
import { PageHeader } from '@aiployee/ui';
import { EmptyState } from '@aiployee/ui';
import { Skeleton } from '@aiployee/ui';
import { useToast } from '@aiployee/ui';

type Cmp = 'eq' | 'neq' | 'contains' | 'exists' | 'gt' | 'lt';
type Op = 'and' | 'or';

interface RuleRow {
  id: number;
  field: string;
  cmp: Cmp;
  value: string;
}

interface SegmentFilter {
  op: Op;
  rules: { field: string; cmp: Cmp; value?: string }[];
}

interface Segment {
  id: string;
  name: string;
  filter: SegmentFilter;
  created_at: string;
}

interface PreviewResult {
  count: number;
  sample: { id: string; email: string; name: string | null }[];
}

const CMP_LABELS: Record<Cmp, string> = {
  eq: 'equals',
  neq: 'not equals',
  contains: 'contains',
  exists: 'exists',
  gt: 'greater than',
  lt: 'less than',
};

let nextRuleId = 1;

function rulesSummary(filter: SegmentFilter): string {
  if (!filter?.rules?.length) return 'No rules';
  const parts = filter.rules.slice(0, 3).map(r => {
    const cmpLabel = CMP_LABELS[r.cmp] ?? r.cmp;
    return r.cmp === 'exists'
      ? `${r.field} exists`
      : `${r.field} ${cmpLabel} ${r.value ?? ''}`;
  });
  const suffix = filter.rules.length > 3 ? ` +${filter.rules.length - 3} more` : '';
  return parts.join(` ${filter.op.toUpperCase()} `) + suffix;
}

export default function Segments() {
  const toast = useToast();
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(true);

  // New segment form state
  const [segName, setSegName] = useState('');
  const [op, setOp] = useState<Op>('and');
  const [rules, setRules] = useState<RuleRow[]>([
    { id: nextRuleId++, field: 'email', cmp: 'contains', value: '' },
  ]);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    api<{ segments: Segment[] }>('/api/segments')
      .then(r => { setSegments(r.segments); setLoading(false); })
      .catch(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  function buildFilter(): SegmentFilter {
    return {
      op,
      rules: rules
        .filter(r => r.field.trim())
        .map(r => ({
          field: r.field.trim(),
          cmp: r.cmp,
          ...(r.cmp !== 'exists' ? { value: r.value } : {}),
        })),
    };
  }

  function addRule() {
    setRules(prev => [...prev, { id: nextRuleId++, field: '', cmp: 'eq', value: '' }]);
    setPreview(null);
  }

  function updateRule(id: number, patch: Partial<Omit<RuleRow, 'id'>>) {
    setRules(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r));
    setPreview(null);
  }

  function removeRule(id: number) {
    setRules(prev => prev.filter(r => r.id !== id));
    setPreview(null);
  }

  async function runPreview() {
    setPreviewing(true);
    try {
      const result = await api<PreviewResult>('/api/segments/preview', {
        method: 'POST',
        body: JSON.stringify({ filter: buildFilter() }),
      });
      setPreview(result);
    } catch (err: unknown) {
      toast.error((err as Error).message);
    } finally {
      setPreviewing(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!segName.trim()) { toast.error('Segment name is required'); return; }
    setSaving(true);
    try {
      await api('/api/segments', {
        method: 'POST',
        body: JSON.stringify({ name: segName.trim(), filter: buildFilter() }),
      });
      setSegName('');
      setOp('and');
      setRules([{ id: nextRuleId++, field: 'email', cmp: 'contains', value: '' }]);
      setPreview(null);
      load();
      toast.success('Segment saved');
    } catch (err: unknown) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function del(seg: Segment) {
    if (!confirm(`Delete segment "${seg.name}"?`)) return;
    try {
      await api(`/api/segments/${seg.id}`, { method: 'DELETE' });
      load();
      toast.success('Deleted');
    } catch (err: unknown) {
      toast.error((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Segments"
        subtitle="Rule-based dynamic audiences — automatically updated as contacts change."
      />

      {/* New segment builder */}
      <Card>
        <form onSubmit={save} className="space-y-4">
          <h2 className="text-sm font-semibold text-ink">New segment</h2>

          <Field label="Segment name">
            <Input
              required
              value={segName}
              onChange={e => setSegName(e.target.value)}
              placeholder="e.g. Active UK subscribers"
            />
          </Field>

          {/* AND / OR toggle */}
          <div className="flex items-center gap-2 text-sm text-ink-muted">
            <span>Match</span>
            <div className="flex rounded-lg border border-line-strong overflow-hidden text-xs font-medium">
              {(['and', 'or'] as Op[]).map(o => (
                <button
                  key={o}
                  type="button"
                  onClick={() => { setOp(o); setPreview(null); }}
                  className={`px-3 py-1 transition-colors ${
                    op === o
                      ? 'bg-magenta text-white'
                      : 'bg-surface-raised text-ink hover:bg-surface'
                  }`}
                >
                  {o.toUpperCase()}
                </button>
              ))}
            </div>
            <span>of the following rules:</span>
          </div>

          {/* Rule rows */}
          <div className="space-y-2">
            {rules.map(rule => (
              <div key={rule.id} className="flex items-center gap-2 flex-wrap">
                {/* Field */}
                <input
                  type="text"
                  value={rule.field}
                  onChange={e => updateRule(rule.id, { field: e.target.value })}
                  placeholder="email / name / subscribed / custom_attr"
                  className="w-52 rounded-lg border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:outline-none focus:border-magenta"
                />
                {/* Comparator */}
                <select
                  value={rule.cmp}
                  onChange={e => updateRule(rule.id, { cmp: e.target.value as Cmp, value: '' })}
                  className="w-full max-w-[140px] rounded-lg border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink"
                >
                  {(Object.entries(CMP_LABELS) as [Cmp, string][]).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
                {/* Value (hidden for 'exists') */}
                {rule.cmp !== 'exists' && (
                  <input
                    type="text"
                    value={rule.value}
                    onChange={e => updateRule(rule.id, { value: e.target.value })}
                    placeholder="value"
                    className="w-40 rounded-lg border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:outline-none focus:border-magenta"
                  />
                )}
                {/* Remove rule */}
                {rules.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeRule(rule.id)}
                    className="text-xs text-ink-dim hover:text-error px-1"
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button type="button" variant="ghost" onClick={addRule}>+ Add rule</Button>
            <Button type="button" variant="secondary" onClick={runPreview} disabled={previewing}>
              {previewing ? 'Previewing…' : 'Preview'}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save segment'}
            </Button>
          </div>

          {/* Preview results */}
          {preview && (
            <div className="rounded-xl border border-line-strong bg-surface-raised p-4 text-sm space-y-2">
              <p className="text-ink font-medium">
                Matches <span className="text-magenta">{preview.count}</span> contact{preview.count !== 1 ? 's' : ''}
              </p>
              {preview.sample.length > 0 && (
                <ul className="space-y-1 text-ink-muted">
                  {preview.sample.map(c => (
                    <li key={c.id}>
                      <span className="text-ink">{c.email}</span>
                      {c.name && <span className="ml-2 text-ink-dim">({c.name})</span>}
                    </li>
                  ))}
                </ul>
              )}
              {preview.count > preview.sample.length && (
                <p className="text-ink-dim text-xs">…and {preview.count - preview.sample.length} more</p>
              )}
            </div>
          )}
        </form>
      </Card>

      {/* Saved segments list */}
      {loading ? (
        <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-9" />)}</div>
      ) : segments.length === 0 ? (
        <EmptyState
          icon={Filter}
          title="No segments yet"
          description="Build a rule-based filter above and save it as a segment."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Rules</Th>
              <Th>Created</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {segments.map(seg => (
              <tr key={seg.id}>
                <Td className="font-medium text-ink">{seg.name}</Td>
                <Td className="text-ink-muted text-xs max-w-xs truncate">{rulesSummary(seg.filter)}</Td>
                <Td className="text-ink-dim text-xs whitespace-nowrap">
                  {new Date(seg.created_at).toLocaleDateString()}
                </Td>
                <Td>
                  <Button variant="ghost" size="sm" onClick={() => del(seg)}>Delete</Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
