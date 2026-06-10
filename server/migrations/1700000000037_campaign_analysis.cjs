/* eslint-disable camelcase */
// Abe inbox intelligence Phase 2: per-campaign reply analysis.
// campaign_analyses = one analysis run (funnel snapshot); reply_groups = clusters of
// replies needing the same response; inbound_emails gains the analysis-output columns.
exports.up = (pgm) => {
  pgm.createTable('campaign_analyses', {
    id:              { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:       { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    campaign_id:     { type: 'uuid', notNull: true, references: 'campaigns(id)', onDelete: 'CASCADE' },
    run_at:          { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    status:          { type: 'text', notNull: true, default: 'running', check: "status IN ('running','ready','failed')" },
    sent_count:      { type: 'int', notNull: true, default: 0 },
    opened_count:    { type: 'int', notNull: true, default: 0 },
    replied_count:   { type: 'int', notNull: true, default: 0 },
    hot_lead_count:  { type: 'int', notNull: true, default: 0 },
    model_cost_note: { type: 'text' },
    error:           { type: 'text' },
  });
  pgm.createIndex('campaign_analyses', ['tenant_id', 'campaign_id', 'run_at']);

  pgm.createTable('reply_groups', {
    id:                   { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:            { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    campaign_analysis_id: { type: 'uuid', notNull: true, references: 'campaign_analyses(id)', onDelete: 'CASCADE' },
    label:                { type: 'text', notNull: true },
    intent_summary:       { type: 'text' },
    size:                 { type: 'int', notNull: true, default: 0 },
    confidence:           { type: 'real' },
    proposed_outline:     { type: 'text' },
    kind:                 { type: 'text', notNull: true, default: 'standard', check: "kind IN ('standard','hot_leads','needs_review')" },
    send_mode:            { type: 'text', check: "send_mode IN ('batch','individual')" },
    draft_status:         { type: 'text', notNull: true, default: 'none', check: "draft_status IN ('none','drafted','queued','sent')" },
    created_at:           { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('reply_groups', ['campaign_analysis_id']);

  pgm.addColumns('inbound_emails', {
    embedding:      { type: 'vector(1536)' },
    reply_group_id: { type: 'uuid', references: 'reply_groups(id)', onDelete: 'SET NULL' },
    group_fit:      { type: 'text', check: "group_fit IN ('fit','misfit','needs_review')" },
    is_hot_lead:    { type: 'boolean', notNull: true, default: false },
  });
  pgm.createIndex('inbound_emails', ['reply_group_id']);
};

exports.down = (pgm) => {
  pgm.dropColumns('inbound_emails', ['embedding', 'reply_group_id', 'group_fit', 'is_hot_lead']);
  pgm.dropTable('reply_groups');
  pgm.dropTable('campaign_analyses');
};
