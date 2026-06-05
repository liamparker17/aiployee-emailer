/* eslint-disable camelcase */
// Agentic call DB foundation: a first-class structured record per inbound call,
// 1:1 with the human-readable agent_messages row, plus a `calls` view that joins
// message + facts + tags. Additive only — no existing table is altered destructively.
exports.up = (pgm) => {
  pgm.createTable('call_facts', {
    id:                      { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:               { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    message_id:              { type: 'uuid', notNull: true, references: 'agent_messages(id)', onDelete: 'CASCADE' },
    caller_suid:             { type: 'text' },
    caller_name:             { type: 'text' },
    caller_phone:            { type: 'text' },
    caller_timezone:         { type: 'text' },
    line_ref:                { type: 'text' },
    attribution_label:       { type: 'text' },
    call_type:               { type: 'text' },
    summary:                 { type: 'text' },
    call_outcome:            { type: 'text' },
    sentiment:               { type: 'text' },
    call_duration_seconds:   { type: 'integer' },
    callback_requested:      { type: 'boolean', notNull: true, default: false },
    callback_preferred_time: { type: 'text' },
    escalation_requested:    { type: 'boolean', notNull: true, default: false },
    resolution_state:        { type: 'text', notNull: true, default: 'open',
                               check: "resolution_state IN ('open','in_progress','resolved','unresolved')" },
    resolved_at:             { type: 'timestamptz' },
    resolved_by:             { type: 'uuid', references: 'users(id)', onDelete: 'SET NULL' },
    fcr:                     { type: 'boolean' },
    values:                  { type: 'jsonb', notNull: true, default: '{}' },
    raw_payload:             { type: 'jsonb', notNull: true, default: '{}' },
    created_at:              { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at:              { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('call_facts', 'call_facts_message_uniq', { unique: ['message_id'] });
  pgm.createIndex('call_facts', ['tenant_id', { name: 'created_at', sort: 'DESC' }]);
  pgm.createIndex('call_facts', ['tenant_id', 'attribution_label']);
  pgm.createIndex('call_facts', ['tenant_id', 'resolution_state']);
  pgm.createIndex('call_facts', ['tenant_id', 'caller_suid']);

  // Per-tenant rule for resolving the "who"/type out of the free-form values payload.
  pgm.addColumn('line_report_configs', {
    attribution_map: { type: 'jsonb', notNull: true, default: '{}' },
  });

  pgm.createView('calls', {}, `
    SELECT m.id AS message_id, m.tenant_id, m.content AS summary_text, m.created_at,
           f.caller_suid, f.caller_name, f.caller_phone,
           f.line_ref, f.attribution_label, f.call_type, f.call_outcome, f.sentiment,
           f.call_duration_seconds, f.callback_requested, f.escalation_requested,
           f.resolution_state, f.fcr, f.values,
           t.category, t.severity
      FROM agent_messages m
      LEFT JOIN call_facts f     ON f.message_id = m.id
      LEFT JOIN line_call_tags t ON t.message_id = m.id
     WHERE m.role = 'inbound' AND m.source = 'jobix'
  `);
};

exports.down = (pgm) => {
  pgm.dropView('calls');
  pgm.dropColumn('line_report_configs', 'attribution_map');
  pgm.dropTable('call_facts');
};
