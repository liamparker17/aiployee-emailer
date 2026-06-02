/* eslint-disable camelcase */
// Abe's second job: Client Line Reporting. Per-tenant config, one tag row per
// inbound call summary (tag-once), and the report drafts that gate before ABSA.
exports.up = (pgm) => {
  pgm.createTable('line_report_configs', {
    id:               { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:        { type: 'uuid', notNull: true, unique: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    enabled:          { type: 'boolean', notNull: true, default: false },
    daily_digest:     { type: 'boolean', notNull: true, default: true },
    weekly_rollup:    { type: 'boolean', notNull: true, default: true },
    weekly_send_day:  { type: 'integer', notNull: true, default: 1 },
    send_hour_utc:    { type: 'integer', notNull: true, default: 6 },
    recipients:       { type: 'jsonb', notNull: true, default: '[]' },
    taxonomy:         { type: 'jsonb', notNull: true, default: JSON.stringify([
                          'Card disputes / fraud','Online & app banking','Debit orders',
                          'Accounts & balances','Loans & credit','Fees & charges','Complaints','Other / Emerging',
                        ]) },
    spike_pct:        { type: 'integer', notNull: true, default: 50 },
    spike_min_count:  { type: 'integer', notNull: true, default: 5 },
    baseline_periods: { type: 'integer', notNull: true, default: 4 },
    brand_voice:      { type: 'text' },
    created_at:       { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at:       { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('line_call_tags', {
    id:          { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:   { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    message_id:  { type: 'uuid', notNull: true, references: 'agent_messages(id)', onDelete: 'CASCADE' },
    category:    { type: 'text', notNull: true },
    severity:    { type: 'text', notNull: true, default: 'low', check: "severity IN ('low','med','high')" },
    is_emerging: { type: 'boolean', notNull: true, default: false },
    created_at:  { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('line_call_tags', 'line_call_tags_message_uniq', { unique: ['message_id'] });
  pgm.createIndex('line_call_tags', ['tenant_id', 'category']);
  pgm.createIndex('line_call_tags', ['tenant_id', { name: 'created_at', sort: 'DESC' }]);

  pgm.createTable('line_reports', {
    id:                 { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:          { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    report_type:        { type: 'text', notNull: true, check: "report_type IN ('digest','alert','answer','case')" },
    period_start:       { type: 'timestamptz' },
    period_end:         { type: 'timestamptz' },
    status:             { type: 'text', notNull: true, default: 'pending_approval',
                          check: "status IN ('pending_approval','approved','sent','rejected','archived')" },
    subject:            { type: 'text', notNull: true },
    body:               { type: 'text', notNull: true },
    metrics:            { type: 'jsonb', notNull: true, default: '{}' },
    advisory:           { type: 'jsonb', notNull: true, default: '{}' },
    source_message_ids: { type: 'jsonb', notNull: true, default: '[]' },
    approved_by:        { type: 'uuid', references: 'users(id)', onDelete: 'SET NULL' },
    approved_at:        { type: 'timestamptz' },
    sent_at:            { type: 'timestamptz' },
    email_id:           { type: 'uuid' },
    reject_reason:      { type: 'text' },
    created_at:         { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('line_reports', ['tenant_id', 'status', { name: 'created_at', sort: 'DESC' }]);
};

exports.down = (pgm) => {
  pgm.dropTable('line_reports');
  pgm.dropTable('line_call_tags');
  pgm.dropTable('line_report_configs');
};
