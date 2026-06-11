/* eslint-disable camelcase */
// Per-tenant connection to the Aiployee WhatsApp platform (Public API v1).
// One connection per tenant; the bearer key is encrypted at rest.
exports.up = (pgm) => {
  pgm.createTable('whatsapp_connections', {
    id:                { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:         { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    base_url:          { type: 'text', notNull: true },
    api_key_encrypted: { type: 'bytea', notNull: true },
    from_number:       { type: 'text' },
    active:            { type: 'boolean', notNull: true, default: true },
    last_ok_at:        { type: 'timestamptz' },
    last_error:        { type: 'text' },
    created_by:        { type: 'uuid', references: 'users(id)', onDelete: 'SET NULL' },
    created_at:        { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at:        { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('whatsapp_connections', 'whatsapp_connections_tenant_uniq', { unique: ['tenant_id'] });
};

exports.down = (pgm) => {
  pgm.dropTable('whatsapp_connections');
};
