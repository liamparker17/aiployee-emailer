import type pg from 'pg';

export interface SegmentRule {
  field: string;
  cmp: 'eq' | 'neq' | 'contains' | 'exists' | 'gt' | 'lt';
  value?: string;
}

export interface SegmentFilter {
  op: 'and' | 'or';
  rules: SegmentRule[];
}

export interface SegmentRow {
  id: string;
  tenant_id: string;
  name: string;
  filter: SegmentFilter;
  created_at: Date;
}

/** Whitelisted standard column names → SQL column reference */
const STANDARD_FIELDS: Record<string, string> = {
  email: 'email',
  name: 'name',
  subscribed: 'subscribed',
};

/** Safe custom-attribute key pattern */
const ATTR_KEY_RE = /^[a-zA-Z0-9_]+$/;

/**
 * Compile a SegmentFilter to a parameterized SQL boolean expression.
 * SECURITY: values are NEVER string-interpolated; only validated key names
 * are inlined for the attributes->>'key' accessor.
 */
export function compileFilter(
  filter: SegmentFilter,
  startIndex = 1,
): { sql: string; params: unknown[] } {
  if (!filter?.rules?.length) return { sql: 'true', params: [] };

  const params: unknown[] = [];
  const fragments: string[] = [];

  for (const rule of filter.rules) {
    const { field, cmp, value } = rule;
    let colExpr: string;

    if (STANDARD_FIELDS[field] !== undefined) {
      colExpr = STANDARD_FIELDS[field];
    } else {
      // Custom attribute — validate key before inlining
      if (!ATTR_KEY_RE.test(field)) continue; // skip unsafe keys
      colExpr = `(attributes->>'${field}')`;
    }

    // called AFTER params.push, so the just-pushed value is the (length)-th param,
    // i.e. placeholder number startIndex + length - 1.
    const paramIdx = () => startIndex + params.length - 1;

    if (cmp === 'exists') {
      fragments.push(`${colExpr} IS NOT NULL`);
    } else if (cmp === 'eq') {
      if (field === 'subscribed') {
        params.push(value === 'true' || value === '1');
      } else {
        params.push(value ?? null);
      }
      fragments.push(`${colExpr} = $${paramIdx()}`);
    } else if (cmp === 'neq') {
      if (field === 'subscribed') {
        params.push(value === 'true' || value === '1');
      } else {
        params.push(value ?? null);
      }
      fragments.push(`${colExpr} <> $${paramIdx()}`);
    } else if (cmp === 'contains') {
      params.push(`%${value ?? ''}%`);
      fragments.push(`${colExpr} ILIKE $${paramIdx()}`);
    } else if (cmp === 'gt') {
      params.push(value ?? null);
      fragments.push(`${colExpr} > $${paramIdx()}`);
    } else if (cmp === 'lt') {
      params.push(value ?? null);
      fragments.push(`${colExpr} < $${paramIdx()}`);
    }
    // unknown cmp — skip
  }

  if (!fragments.length) return { sql: 'true', params: [] };

  const joiner = filter.op === 'or' ? ' OR ' : ' AND ';
  const sql = fragments.length === 1 ? fragments[0] : `(${fragments.join(joiner)})`;
  return { sql, params };
}

const COLS = 'id, tenant_id, name, filter, created_at';

export async function listSegments(
  pool: pg.Pool,
  tenantId: string,
): Promise<SegmentRow[]> {
  const r = await pool.query<SegmentRow>(
    `SELECT ${COLS} FROM segments WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );
  return r.rows;
}

export async function getSegment(
  pool: pg.Pool,
  tenantId: string,
  id: string,
): Promise<SegmentRow | null> {
  const r = await pool.query<SegmentRow>(
    `SELECT ${COLS} FROM segments WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return r.rows[0] ?? null;
}

export async function createSegment(
  pool: pg.Pool,
  tenantId: string,
  name: string,
  filter: SegmentFilter,
): Promise<SegmentRow> {
  const r = await pool.query<SegmentRow>(
    `INSERT INTO segments(tenant_id, name, filter) VALUES ($1, $2, $3) RETURNING ${COLS}`,
    [tenantId, name, JSON.stringify(filter)],
  );
  return r.rows[0];
}

export async function deleteSegment(
  pool: pg.Pool,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const r = await pool.query(
    `DELETE FROM segments WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function previewSegment(
  pool: pg.Pool,
  tenantId: string,
  filter: SegmentFilter,
  sampleLimit = 10,
): Promise<{ count: number; sample: { id: string; email: string; name: string | null }[] }> {
  const { sql, params } = compileFilter(filter, 2);

  const countResult = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM contacts WHERE tenant_id = $1 AND (${sql})`,
    [tenantId, ...params],
  );
  const count = countResult.rows[0]?.count ?? 0;

  const sampleResult = await pool.query<{ id: string; email: string; name: string | null }>(
    `SELECT id, email, name FROM contacts WHERE tenant_id = $1 AND (${sql}) ORDER BY created_at DESC LIMIT ${sampleLimit}`,
    [tenantId, ...params],
  );

  return { count, sample: sampleResult.rows };
}

export async function listSegmentContactIds(
  pool: pg.Pool,
  tenantId: string,
  filter: SegmentFilter,
): Promise<string[]> {
  const { sql, params } = compileFilter(filter, 2);
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM contacts WHERE tenant_id = $1 AND (${sql})`,
    [tenantId, ...params],
  );
  return r.rows.map(row => row.id);
}
