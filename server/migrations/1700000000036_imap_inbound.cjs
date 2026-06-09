/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.createTable('imap_configs', {
    id:                 { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:          { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    sender_id:          { type: 'uuid', references: 'senders(id)', onDelete: 'SET NULL' },
    host:               { type: 'text', notNull: true },
    port:               { type: 'int',  notNull: true, default: 993 },
    secure:             { type: 'boolean', notNull: true, default: true },
    username:           { type: 'text', notNull: true },
    password_encrypted: { type: 'bytea', notNull: true },
    enabled:            { type: 'boolean', notNull: true, default: true },
    last_error:         { type: 'text' },
    created_at:         { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at:         { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('imap_configs', ['tenant_id']);

  pgm.createTable('imap_sync_state', {
    imap_config_id: { type: 'uuid', notNull: true, references: 'imap_configs(id)', onDelete: 'CASCADE' },
    folder:         { type: 'text', notNull: true, default: 'INBOX' },
    uid_validity:   { type: 'bigint', notNull: true, default: 0 },
    last_seen_uid:  { type: 'bigint', notNull: true, default: 0 },
    last_synced_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('imap_sync_state', 'imap_sync_state_pk', { primaryKey: ['imap_config_id', 'folder'] });

  pgm.createTable('inbound_emails', {
    id:             { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:      { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    imap_config_id: { type: 'uuid', notNull: true, references: 'imap_configs(id)', onDelete: 'CASCADE' },
    imap_uid:       { type: 'bigint', notNull: true },
    message_id:     { type: 'text', notNull: true },
    in_reply_to:    { type: 'text' },
    msg_references: { type: 'text' },
    from_addr:      { type: 'text', notNull: true },
    from_name:      { type: 'text' },
    to_addr:        { type: 'text' },
    subject:        { type: 'text' },
    body_text:      { type: 'text' },
    body_html:      { type: 'text' },
    received_at:    { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    email_id:       { type: 'uuid', references: 'emails(id)', onDelete: 'SET NULL' },
    campaign_id:    { type: 'uuid', references: 'campaigns(id)', onDelete: 'SET NULL' },
    contact_id:     { type: 'uuid', references: 'contacts(id)', onDelete: 'SET NULL' },
    status:         { type: 'text', notNull: true, default: 'new' },
    created_at:     { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('inbound_emails', 'inbound_emails_tenant_msgid_uniq', { unique: ['tenant_id', 'message_id'] });
  pgm.addConstraint('inbound_emails', 'inbound_emails_config_uid_uniq', { unique: ['imap_config_id', 'imap_uid'] });
  pgm.createIndex('inbound_emails', ['tenant_id', 'received_at'], { name: 'inbound_emails_tenant_received_idx' });
  pgm.createIndex('inbound_emails', ['campaign_id']);
  pgm.createIndex('inbound_emails', ['email_id']);
};

exports.down = (pgm) => {
  pgm.dropTable('inbound_emails');
  pgm.dropTable('imap_sync_state');
  pgm.dropTable('imap_configs');
};
