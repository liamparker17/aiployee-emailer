/* eslint-disable camelcase */
// Campaign flow builder: flows -> ordered steps; contacts get enrolled and walked through
// the steps by a cron engine. Additive; reuses fireTrigger (jobix_triggers) for call steps.
exports.up = (pgm) => {
  pgm.createTable('flows', {
    id:         { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:  { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    name:       { type: 'text', notNull: true },
    status:     { type: 'text', notNull: true, default: 'draft',
                  check: "status IN ('draft','active','paused','archived')" },
    created_by: { type: 'uuid', references: 'users(id)', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('flows', ['tenant_id', 'status']);

  pgm.createTable('flow_steps', {
    id:         { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:  { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    flow_id:    { type: 'uuid', notNull: true, references: 'flows(id)', onDelete: 'CASCADE' },
    position:   { type: 'integer', notNull: true },
    kind:       { type: 'text', notNull: true,
                  check: "kind IN ('wait','jobix_call','email','condition')" },
    config:     { type: 'jsonb', notNull: true, default: '{}' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('flow_steps', ['flow_id', 'position']);

  pgm.createTable('flow_enrollments', {
    id:               { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:        { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    flow_id:          { type: 'uuid', notNull: true, references: 'flows(id)', onDelete: 'CASCADE' },
    contact_id:       { type: 'uuid', references: 'contacts(id)', onDelete: 'SET NULL' },
    name:             { type: 'text', notNull: true, default: '' },
    phone:            { type: 'text', notNull: true, default: '' },
    email:            { type: 'text', notNull: true, default: '' },
    context:          { type: 'jsonb', notNull: true, default: '{}' },
    status:           { type: 'text', notNull: true, default: 'active',
                        check: "status IN ('active','completed','exited','failed')" },
    current_position: { type: 'integer', notNull: true, default: 0 },
    next_run_at:      { type: 'timestamptz' },
    last_error:       { type: 'text' },
    created_at:       { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at:       { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('flow_enrollments', ['flow_id', 'status']);
  pgm.createIndex('flow_enrollments', ['tenant_id', 'status']);
  pgm.createIndex('flow_enrollments', ['status', 'next_run_at']);
};

exports.down = (pgm) => {
  pgm.dropTable('flow_enrollments');
  pgm.dropTable('flow_steps');
  pgm.dropTable('flows');
};
