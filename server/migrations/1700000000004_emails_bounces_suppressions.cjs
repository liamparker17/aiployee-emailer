/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.createTable('emails', {
    id:             { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:      { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    sender_id:      { type: 'uuid', notNull: true, references: 'senders(id)' },
    to_addr:        { type: 'text', notNull: true },
    cc:             { type: 'text[]', notNull: true, default: '{}' },
    bcc:            { type: 'text[]', notNull: true, default: '{}' },
    reply_to:       { type: 'text' },
    subject:        { type: 'text', notNull: true },
    body_html:      { type: 'text', notNull: true },
    body_text:      { type: 'text' },
    template_id:    { type: 'uuid', references: 'templates(id)' },
    attachments:    { type: 'jsonb', notNull: true, default: '[]' },
    status:         { type: 'text', notNull: true, check: "status IN ('queued','sending','sent','failed','bounced','complained','suppressed')" },
    scheduled_for:  { type: 'timestamptz' },
    sent_at:        { type: 'timestamptz' },
    error:          { type: 'text' },
    message_id:     { type: 'text' },
    api_key_id:     { type: 'uuid', references: 'api_keys(id)' },
    created_at:     { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('emails', ['tenant_id', { name: 'created_at', sort: 'DESC' }]);
  pgm.createIndex('emails', ['scheduled_for'], { where: "status = 'queued'", name: 'emails_queued_scheduled_idx' });
  pgm.createIndex('emails', ['message_id'], { where: 'message_id IS NOT NULL' });
  pgm.createTable('bounce_events', {
    id:           { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    email_id:     { type: 'uuid', notNull: true, references: 'emails(id)', onDelete: 'CASCADE' },
    type:         { type: 'text', notNull: true, check: "type IN ('bounce','complaint','delivery')" },
    raw_payload:  { type: 'jsonb', notNull: true },
    received_at:  { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createTable('suppressions', {
    id:         { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:  { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    address:    { type: 'text', notNull: true },
    reason:     { type: 'text', notNull: true, check: "reason IN ('bounce','complaint','manual')" },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('suppressions', 'suppressions_tenant_address_uniq', { unique: ['tenant_id', 'address'] });
};
exports.down = (pgm) => {
  pgm.dropTable('suppressions');
  pgm.dropTable('bounce_events');
  pgm.dropTable('emails');
};
