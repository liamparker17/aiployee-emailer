/* eslint-disable camelcase */
// Abe (agentic employee): goals, proposed plays, manager approvals, and per-play outcomes.
exports.up = (pgm) => {
  pgm.createTable('agent_goals', {
    id:                        { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:                 { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    kind:                      { type: 'text', notNull: true, default: 'reengage_dormant', check: "kind IN ('reengage_dormant')" },
    enabled:                   { type: 'boolean', notNull: true, default: false },
    schedule:                  { type: 'text', notNull: true, default: 'daily', check: "schedule IN ('daily')" },
    dormant_window_days:       { type: 'integer', notNull: true, default: 60 },
    auto_fire_max_audience:    { type: 'integer', notNull: true, default: 0 },
    max_touches:               { type: 'integer', notNull: true, default: 3 },
    touch_spacing_days:        { type: 'integer', notNull: true, default: 3 },
    line_manager_email:        { type: 'text' },
    line_manager_verified_at:  { type: 'timestamptz' },
    brand_voice:               { type: 'text' },
    created_at:                { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at:                { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('agent_goals', 'agent_goals_tenant_kind_uniq', { unique: ['tenant_id', 'kind'] });

  pgm.createTable('agent_plays', {
    id:                { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:         { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    goal_id:           { type: 'uuid', notNull: true, references: 'agent_goals(id)', onDelete: 'CASCADE' },
    status:            { type: 'text', notNull: true, default: 'proposed',
                         check: "status IN ('proposed','pending_approval','approved','rejected','executing','done','archived')" },
    risk_score:        { type: 'integer', notNull: true, default: 0 },
    audience_snapshot: { type: 'jsonb', notNull: true, default: '{"contact_ids":[],"size":0}' },
    touches:           { type: 'jsonb', notNull: true, default: '[]' },
    rejection_reason:  { type: 'text' },
    created_at:        { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at:        { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('agent_plays', ['tenant_id', { name: 'created_at', sort: 'DESC' }]);

  pgm.createTable('agent_approvals', {
    id:            { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    play_id:       { type: 'uuid', notNull: true, references: 'agent_plays(id)', onDelete: 'CASCADE' },
    tenant_id:     { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    token_hash:    { type: 'text', notNull: true },
    manager_email: { type: 'text', notNull: true },
    channel:       { type: 'text', notNull: true, default: 'button', check: "channel IN ('button','reply')" },
    decision:      { type: 'text', check: "decision IN ('approve','reject','edit')" },
    decided_at:    { type: 'timestamptz' },
    expires_at:    { type: 'timestamptz', notNull: true },
    consumed_at:   { type: 'timestamptz' },
    created_at:    { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('agent_approvals', ['play_id']);

  pgm.createTable('agent_play_outcomes', {
    id:              { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    play_id:         { type: 'uuid', notNull: true, references: 'agent_plays(id)', onDelete: 'CASCADE' },
    tenant_id:       { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    touch_index:     { type: 'integer', notNull: true },
    sends:           { type: 'integer', notNull: true, default: 0 },
    opens:           { type: 'integer', notNull: true, default: 0 },
    clicks:          { type: 'integer', notNull: true, default: 0 },
    reactivations:   { type: 'integer', notNull: true, default: 0 },
    window_closed_at:{ type: 'timestamptz' },
    created_at:      { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at:      { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('agent_play_outcomes', ['play_id']);
};

exports.down = (pgm) => {
  pgm.dropTable('agent_play_outcomes');
  pgm.dropTable('agent_approvals');
  pgm.dropTable('agent_plays');
  pgm.dropTable('agent_goals');
};
