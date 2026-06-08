/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.createTable('jobix_triggers', {
    id:               { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:        { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    label:            { type: 'text', notNull: true },
    url:              { type: 'text', notNull: true },
    token_encrypted:  { type: 'bytea', notNull: true },
    token_placement:  { type: 'text', notNull: true, default: 'bearer',
                        check: "token_placement IN ('bearer','header','query','body')" },
    token_param:      { type: 'text' },
    payload_template: { type: 'text', notNull: true, default: '{}' },
    active:           { type: 'boolean', notNull: true, default: true },
    last_fired_at:    { type: 'timestamptz' },
    created_by:       { type: 'uuid', references: 'users(id)', onDelete: 'SET NULL' },
    created_at:       { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at:       { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('jobix_triggers', 'jobix_triggers_tenant_label_uniq', { unique: ['tenant_id', 'label'] });
  pgm.createIndex('jobix_triggers', ['tenant_id']);

  pgm.createTable('jobix_trigger_fires', {
    id:               { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:        { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    trigger_id:       { type: 'uuid', notNull: true, references: 'jobix_triggers(id)', onDelete: 'CASCADE' },
    source:           { type: 'text', notNull: true, default: 'manual',
                        check: "source IN ('manual','test','event','abe')" },
    vars:             { type: 'jsonb', notNull: true, default: '{}' },
    http_status:      { type: 'integer' },
    ok:               { type: 'boolean', notNull: true },
    response_snippet: { type: 'text' },
    error:            { type: 'text' },
    created_by:       { type: 'uuid', references: 'users(id)', onDelete: 'SET NULL' },
    created_at:       { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('jobix_trigger_fires', ['tenant_id', { name: 'created_at', sort: 'DESC' }]);
  pgm.createIndex('jobix_trigger_fires', ['trigger_id']);
};

exports.down = (pgm) => {
  pgm.dropTable('jobix_trigger_fires');
  pgm.dropTable('jobix_triggers');
};
