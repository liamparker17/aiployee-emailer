/* eslint-disable camelcase */
// Phase 1 of the agentic AI-responses platform: per-tenant agent config, Jobix-driven
// threads, and messages (with a human-approval workflow). No external tools yet.
exports.up = (pgm) => {
  pgm.createTable('agent_configs', {
    id:                   { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:            { type: 'uuid', notNull: true, unique: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    enabled:              { type: 'boolean', notNull: true, default: false },
    model:                { type: 'text', notNull: true, default: 'gpt-4o' },
    system_prompt:        { type: 'text', notNull: true, default: '' },
    openai_key_encrypted: { type: 'bytea' },
    auto_approve_jobix:   { type: 'boolean', notNull: true, default: true },
    max_tool_iterations:  { type: 'int', notNull: true, default: 4 },
    created_at:           { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at:           { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('agent_threads', {
    id:               { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:        { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    jobix_thread_ref: { type: 'text', notNull: true },
    subject:          { type: 'text' },
    status:           { type: 'text', notNull: true, default: 'open', check: "status IN ('open','closed')" },
    created_at:       { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at:       { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('agent_threads', 'agent_threads_tenant_ref_uniq', { unique: ['tenant_id', 'jobix_thread_ref'] });

  pgm.createTable('agent_messages', {
    id:          { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    thread_id:   { type: 'uuid', notNull: true, references: 'agent_threads(id)', onDelete: 'CASCADE' },
    tenant_id:   { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    role:        { type: 'text', notNull: true, check: "role IN ('inbound','agent','system')" },
    source:      { type: 'text', notNull: true, check: "source IN ('jobix','manual')" },
    content:     { type: 'text', notNull: true },
    status:      { type: 'text', notNull: true, default: 'pending_approval', check: "status IN ('pending_approval','approved','sent','rejected')" },
    message_ref: { type: 'text' },
    approved_by: { type: 'uuid', references: 'users(id)', onDelete: 'SET NULL' },
    approved_at: { type: 'timestamptz' },
    created_at:  { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('agent_messages', ['thread_id']);
  // Idempotency for Jobix retries: a given (tenant, message_ref) ingested once.
  pgm.createIndex('agent_messages', ['tenant_id', 'message_ref'], {
    unique: true, where: 'message_ref IS NOT NULL', name: 'agent_messages_tenant_msgref_uniq',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('agent_messages');
  pgm.dropTable('agent_threads');
  pgm.dropTable('agent_configs');
};
