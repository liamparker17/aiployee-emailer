import type pg from 'pg';

function toVectorLiteral(embedding: number[]): string {
  return '[' + embedding.join(',') + ']';
}

export async function insertDocument(
  pool: pg.Pool,
  input: { tenantId: string; source: string; content: string; embedding: number[]; metadata?: Record<string, unknown> },
): Promise<{ id: string }> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO rag_documents (tenant_id, source, content, embedding, metadata)
     VALUES ($1, $2, $3, $4::vector, $5)
     RETURNING id`,
    [input.tenantId, input.source, input.content, toVectorLiteral(input.embedding), JSON.stringify(input.metadata ?? {})],
  );
  return r.rows[0];
}

export interface RagMatch { content: string; source: string; distance: number }

export async function searchDocuments(
  pool: pg.Pool,
  tenantId: string,
  embedding: number[],
  limit = 5,
): Promise<RagMatch[]> {
  const r = await pool.query<RagMatch>(
    `SELECT content, source, (embedding <-> $2::vector) AS distance
     FROM rag_documents
     WHERE tenant_id = $1
     ORDER BY embedding <-> $2::vector
     LIMIT $3`,
    [tenantId, toVectorLiteral(embedding), limit],
  );
  return r.rows;
}

export async function countRagDocuments(pool: pg.Pool, tenantId: string): Promise<number> {
  const r = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM rag_documents WHERE tenant_id = $1`, [tenantId]);
  return r.rows[0].count;
}

export async function listRagSources(pool: pg.Pool, tenantId: string): Promise<{ source: string; documents: number }[]> {
  const r = await pool.query<{ source: string; documents: number }>(
    `SELECT source, count(*)::int AS documents FROM rag_documents WHERE tenant_id = $1 GROUP BY source ORDER BY source`, [tenantId]);
  return r.rows;
}

export async function deleteDocumentsBySource(
  pool: pg.Pool,
  tenantId: string,
  source: string,
): Promise<number> {
  const r = await pool.query(
    `DELETE FROM rag_documents WHERE tenant_id = $1 AND source = $2`,
    [tenantId, source],
  );
  return r.rowCount ?? 0;
}
