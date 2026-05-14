/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.createTable('smtp_configs', {
    id:                 { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:          { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    name:               { type: 'text', notNull: true },
    host:               { type: 'text', notNull: true },
    port:               { type: 'int',  notNull: true },
    secure:             { type: 'boolean', notNull: true, default: false },
    username:           { type: 'text', notNull: true },
    password_encrypted: { type: 'bytea', notNull: true },
    from_domain:        { type: 'text', notNull: true },
    is_default:         { type: 'boolean', notNull: true, default: false },
    created_at:         { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('smtp_configs', 'smtp_tenant_name_uniq', { unique: ['tenant_id', 'name'] });
  pgm.createTable('senders', {
    id:             { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:      { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    email:          { type: 'text', notNull: true },
    display_name:   { type: 'text', notNull: true },
    reply_to:       { type: 'text' },
    smtp_config_id: { type: 'uuid', notNull: true, references: 'smtp_configs(id)' },
    is_default:     { type: 'boolean', notNull: true, default: false },
    created_at:     { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('senders', 'senders_tenant_email_uniq', { unique: ['tenant_id', 'email'] });
};
exports.down = (pgm) => {
  pgm.dropTable('senders');
  pgm.dropTable('smtp_configs');
};
