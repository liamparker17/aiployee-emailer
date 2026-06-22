/* eslint-disable camelcase */
// Agentic conversation spine. agent_threads = the durable per-conversation operating
// state (one row per tenant+contact+campaign), upserted from correlated inbound replies.
// agent_actions = a generalized human-approval queue that supersedes the plays-only
// approval surface: Abe proposes an action, a human approves/edits/rejects/assigns/snoozes.
exports.up = (pgm) => {
  pgm.createTable('agent_threads', {
    id:                       { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:                { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    contact_id:               { type: 'uuid', references: 'contacts(id)', onDelete: 'SET NULL' },
    campaign_id:              { type: 'uuid', references: 'campaigns(id)', onDelete: 'SET NULL' },
    latest_inbound_email_id:  { type: 'uuid', references: 'inbound_emails(id)', onDelete: 'SET NULL' },
    latest_outbound_email_id: { type: 'uuid', references: 'emails(id)', onDelete: 'SET NULL' },
    stage:                    { type: 'text', notNull: true, default: 'needs_triage',
      check: "stage IN ('new_reply','needs_triage','needs_human_reply','draft_ready','awaiting_customer','follow_up_due','escalated','converted','lost','closed','unsubscribed')" },
    intent:                   { type: 'text',
      check: "intent IN ('interested','pricing_request','booking_request','callback_request','not_interested','objection','complaint','wrong_person','out_of_office','unsubscribe_intent','admin_query','unknown')" },
    sentiment:                { type: 'text', check: "sentiment IN ('positive','neutral','negative')" },
    urgency:                  { type: 'text', check: "urgency IN ('low','medium','high')" },
    lead_score:               { type: 'integer' },
    objection_type:           { type: 'text', check: "objection_type IN ('price','timing','trust','confusion','other')" },
    commercial_value:         { type: 'text', check: "commercial_value IN ('low','medium','high')" },
    owner_user_id:            { type: 'uuid', references: 'users(id)', onDelete: 'SET NULL' },
    next_action:              { type: 'text' },
    next_action_due_at:       { type: 'timestamptz' },
    status:                   { type: 'text', notNull: true, default: 'open', check: "status IN ('open','closed')" },
    source:                   { type: 'text', notNull: true, default: 'campaign_reply', check: "source IN ('campaign_reply','inbound','manual')" },
    confidence:               { type: 'real' },
    last_agent_analysis_at:   { type: 'timestamptz' },
    created_at:               { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at:               { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  // One thread per (tenant, contact, campaign). COALESCE the nullable campaign_id to a
  // zero-uuid so contact-only (non-campaign) conversations also dedup to a single row.
  pgm.sql(`CREATE UNIQUE INDEX agent_threads_conv_uniq
           ON agent_threads (tenant_id, contact_id, COALESCE(campaign_id, '00000000-0000-0000-0000-000000000000'::uuid))`);
  pgm.createIndex('agent_threads', ['tenant_id', 'status', 'next_action_due_at']);
  pgm.createIndex('agent_threads', ['tenant_id', 'stage']);

  pgm.createTable('agent_actions', {
    id:                  { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:           { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    thread_id:           { type: 'uuid', references: 'agent_threads(id)', onDelete: 'CASCADE' },
    campaign_id:         { type: 'uuid', references: 'campaigns(id)', onDelete: 'SET NULL' },
    contact_id:          { type: 'uuid', references: 'contacts(id)', onDelete: 'SET NULL' },
    action_type:         { type: 'text', notNull: true,
      check: "action_type IN ('send_reply','send_follow_up','create_callback_task','create_handover','mark_hot_lead','assign_owner','pause_sequence','resume_sequence','escalate_thread','send_client_update')" },
    title:               { type: 'text', notNull: true },
    draft_subject:       { type: 'text' },
    draft_body:          { type: 'text' },
    recommended_by:      { type: 'text', notNull: true, default: 'abe' },
    reason:              { type: 'text' },
    confidence:          { type: 'real' },
    risk_level:          { type: 'text', notNull: true, default: 'medium', check: "risk_level IN ('low','medium','high')" },
    source_refs:         { type: 'jsonb', notNull: true, default: '{}' },
    status:              { type: 'text', notNull: true, default: 'pending',
      check: "status IN ('pending','approved','rejected','executed','snoozed')" },
    assigned_to_user_id: { type: 'uuid', references: 'users(id)', onDelete: 'SET NULL' },
    approved_by_user_id: { type: 'uuid', references: 'users(id)', onDelete: 'SET NULL' },
    approved_at:         { type: 'timestamptz' },
    snoozed_until:       { type: 'timestamptz' },
    edited_payload:      { type: 'jsonb' },
    executed_at:         { type: 'timestamptz' },
    created_at:          { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at:          { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('agent_actions', ['tenant_id', 'status', 'created_at']);
  pgm.createIndex('agent_actions', ['thread_id']);
};

exports.down = (pgm) => {
  pgm.dropTable('agent_actions');
  pgm.dropTable('agent_threads');
};
