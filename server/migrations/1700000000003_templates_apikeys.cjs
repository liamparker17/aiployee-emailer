/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.createTable('templates', {
    id:         { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:  { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    name:       { type: 'text', notNull: true },
    subject:    { type: 'text', notNull: true },
    body_html:  { type: 'text', notNull: true },
    body_text:  { type: 'text' },
    variables:  { type: 'jsonb', notNull: true, default: '[]' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('templates', 'templates_tenant_name_uniq', { unique: ['tenant_id', 'name'] });
  pgm.createTable('api_keys', {
    id:           { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:    { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    name:         { type: 'text', notNull: true },
    key_hash:     { type: 'text', notNull: true, unique: true },
    key_prefix:   { type: 'text', notNull: true },
    created_at:   { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_used_at: { type: 'timestamptz' },
    revoked_at:   { type: 'timestamptz' },
  });
  pgm.createIndex('api_keys', ['tenant_id']);
};
exports.down = (pgm) => {
  pgm.dropTable('api_keys');
  pgm.dropTable('templates');
};
