/* eslint-disable camelcase */
exports.up = (pgm) => {
  // --- call_agents: per-tenant Jobix agent registry (encrypted company_key + values schema) ---
  pgm.createTable('call_agents', {
    id:                     { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:              { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    label:                  { type: 'text', notNull: true },
    company_key_encrypted:  { type: 'bytea', notNull: true },
    values_schema:          { type: 'jsonb', notNull: true, default: '[]' },
    default_timezone:       { type: 'text', notNull: true, default: 'Africa/Johannesburg' },
    active:                 { type: 'boolean', notNull: true, default: true },
    created_by:             { type: 'uuid', references: 'users(id)', onDelete: 'SET NULL' },
    created_at:             { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at:             { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('call_agents', 'call_agents_tenant_label_uniq', { unique: ['tenant_id', 'label'] });

  // --- call_campaigns: mirrors the email `campaigns` table ---
  pgm.createTable('call_campaigns', {
    id:              { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:       { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    agent_id:        { type: 'uuid', notNull: true, references: 'call_agents(id)', onDelete: 'RESTRICT' },
    name:            { type: 'text', notNull: true },
    audience_type:   { type: 'text', notNull: true, check: "audience_type IN ('list','segment','csv')" },
    audience_id:     { type: 'uuid' },
    scheduled_for:   { type: 'timestamptz' },
    status:          { type: 'text', notNull: true, default: 'draft',
                       check: "status IN ('draft','approved','running','paused','completed','canceled')" },
    recipient_count: { type: 'integer', notNull: true, default: 0 },
    approved_by:     { type: 'uuid', references: 'users(id)', onDelete: 'SET NULL' },
    approved_at:     { type: 'timestamptz' },
    created_by:      { type: 'uuid', references: 'users(id)', onDelete: 'SET NULL' },
    created_at:      { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at:      { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('call_campaigns', ['tenant_id', 'status']);
  pgm.createIndex('call_campaigns', ['agent_id']);

  // --- call_campaign_recipients: per-recipient, mirrors `emails` rows ---
  pgm.createTable('call_campaign_recipients', {
    id:                 { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:          { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    campaign_id:        { type: 'uuid', notNull: true, references: 'call_campaigns(id)', onDelete: 'CASCADE' },
    suid:               { type: 'text', notNull: true },
    name:               { type: 'text', notNull: true },
    phone:              { type: 'text', notNull: true },
    timezone:           { type: 'text' },
    values:             { type: 'jsonb', notNull: true, default: '{}' },
    contact_id:         { type: 'uuid', references: 'contacts(id)', onDelete: 'SET NULL' },
    status:             { type: 'text', notNull: true, default: 'pending',
                          check: "status IN ('pending','queued','launched','failed','suppressed','completed','canceled')" },
    attempts:           { type: 'integer', notNull: true, default: 0 },
    last_error:         { type: 'text' },
    jobix_response:     { type: 'jsonb' },
    launched_at:        { type: 'timestamptz' },
    result_message_id:  { type: 'uuid', references: 'agent_messages(id)', onDelete: 'SET NULL' },
    outcome:            { type: 'text' },
    created_at:         { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at:         { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('call_campaign_recipients', 'call_recipients_tenant_suid_uniq', { unique: ['tenant_id', 'suid'] });
  pgm.createIndex('call_campaign_recipients', ['campaign_id', 'status']);
  pgm.createIndex('call_campaign_recipients', ['result_message_id']);
};

exports.down = (pgm) => {
  pgm.dropTable('call_campaign_recipients');
  pgm.dropTable('call_campaigns');
  pgm.dropTable('call_agents');
};
