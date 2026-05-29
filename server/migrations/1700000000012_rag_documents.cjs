/* eslint-disable camelcase */
// RAG: per-tenant document store with pgvector embeddings.
exports.up = (pgm) => {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS vector');
  pgm.createTable('rag_documents', {
    id:         { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:  { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    source:     { type: 'text', notNull: true },
    content:    { type: 'text', notNull: true },
    embedding:  { type: 'vector(1536)', notNull: true },
    metadata:   { type: 'jsonb', notNull: true, default: '{}' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('rag_documents', ['tenant_id']);
};
exports.down = (pgm) => {
  pgm.dropTable('rag_documents');
};
