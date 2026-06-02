/* eslint-disable camelcase */
// First Assist's core job: overflow calls forwarded to ABSA for callback.
// One handover per inbound call (agent_messages); only the forward action sends.
exports.up = (pgm) => {
  pgm.createTable('call_handovers', {
    id:                 { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:          { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    message_id:         { type: 'uuid', notNull: true, references: 'agent_messages(id)', onDelete: 'CASCADE' },
    caller_name:        { type: 'text' },
    caller_phone:       { type: 'text' },
    account_ref:        { type: 'text' },
    reason_category:    { type: 'text', notNull: true, default: 'Other / Emerging' },
    summary:            { type: 'text', notNull: true, default: '' },
    recommended_action: { type: 'text', notNull: true, default: '' },
    urgency:            { type: 'text', notNull: true, default: 'med', check: "urgency IN ('low','med','high')" },
    vulnerable:         { type: 'boolean', notNull: true, default: false },
    missing_fields:     { type: 'jsonb', notNull: true, default: '[]' },
    repeat_of:          { type: 'uuid' },
    status:             { type: 'text', notNull: true, default: 'pending', check: "status IN ('pending','forwarded','dismissed')" },
    approved_by:        { type: 'uuid', references: 'users(id)', onDelete: 'SET NULL' },
    forwarded_at:       { type: 'timestamptz' },
    email_id:           { type: 'uuid' },
    dismiss_reason:     { type: 'text' },
    created_at:         { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('call_handovers', 'call_handovers_message_uniq', { unique: ['message_id'] });
  pgm.createIndex('call_handovers', ['tenant_id', 'status', 'urgency', 'created_at']);
  pgm.createIndex('call_handovers', ['tenant_id', 'caller_phone']);
  pgm.createIndex('call_handovers', ['tenant_id', 'account_ref']);
};

exports.down = (pgm) => { pgm.dropTable('call_handovers'); };
