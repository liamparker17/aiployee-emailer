/* eslint-disable camelcase */
// Phase 4: tenant-configured read-only SQL data sources the agent can query as tools.
exports.up = (pgm) => {
  pgm.createTable('rag_sql_sources', {
    id:                    { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:             { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    name:                  { type: 'text', notNull: true },
    connection_encrypted:  { type: 'bytea', notNull: true },
    enabled:               { type: 'boolean', notNull: true, default: true },
    created_at:            { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('rag_sql_sources', ['tenant_id']);
};
exports.down = (pgm) => {
  pgm.dropTable('rag_sql_sources');
};
