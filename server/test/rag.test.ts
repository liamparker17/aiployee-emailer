import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { makePool, truncateAll, TEST_DB_URL } from './helpers/db.js';
import { createTenant } from './helpers/factories.js';
import { ragSqlProvider } from '../src/agent/ragSqlProvider.js';
import { insertDocument, searchDocuments, countRagDocuments } from '../src/repos/ragDocuments.js';

const pool = makePool();
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('RAG SQL provider (read-only)', () => {
  it('exposes a per-source tool and runs a SELECT', async () => {
    const provider = ragSqlProvider([{ id: '1', name: 'testdb', connection: TEST_DB_URL }]);
    const tools = await provider.listTools();
    expect(tools.map(t => t.name)).toEqual(['sql_testdb']);
    const res = await provider.callTool('sql_testdb', { sql: 'SELECT 1 AS x' });
    expect(res).toContain('"x":1');
    await provider.close();
  });

  it('rejects writes via the read-only transaction', async () => {
    const provider = ragSqlProvider([{ id: '1', name: 'testdb', connection: TEST_DB_URL }]);
    const res = await provider.callTool('sql_testdb', { sql: 'CREATE TABLE rag_write_test (i int)' });
    expect(res.toLowerCase()).toContain('error');
    await provider.close();
    const r = await pool.query<{ t: string | null }>(`SELECT to_regclass('public.rag_write_test') AS t`);
    expect(r.rows[0].t).toBeNull(); // the write never happened
  });
});

describe('RAG vector store (pgvector)', () => {
  it('inserts documents and finds the nearest by embedding', async () => {
    const t = await createTenant(pool);
    const a = new Array(1536).fill(0); a[0] = 1;
    const b = new Array(1536).fill(0); b[1] = 1;
    await insertDocument(pool, { tenantId: t.id, source: 'kb', content: 'doc A', embedding: a });
    await insertDocument(pool, { tenantId: t.id, source: 'kb', content: 'doc B', embedding: b });
    expect(await countRagDocuments(pool, t.id)).toBe(2);
    const matches = await searchDocuments(pool, t.id, a, 1);
    expect(matches[0].content).toBe('doc A');
  });
});
