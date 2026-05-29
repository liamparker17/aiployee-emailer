/* eslint-disable camelcase */
// Marketing Phase B: dynamic segments (saved rule-based filters over contacts).
exports.up = (pgm) => {
  pgm.createTable('segments', {
    id:         { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:  { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    name:       { type: 'text', notNull: true },
    filter:     { type: 'jsonb', notNull: true, default: '{}' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('segments', ['tenant_id']);
};
exports.down = (pgm) => {
  pgm.dropTable('segments');
};
