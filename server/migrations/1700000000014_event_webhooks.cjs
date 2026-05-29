/* eslint-disable camelcase */
// Tenant-facing event webhooks: tenants register URLs to receive email lifecycle events
// (sent, delivered, bounced, complained), HMAC-signed with an encrypted secret.
exports.up = (pgm) => {
  pgm.createTable('event_webhooks', {
    id:               { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:        { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    url:              { type: 'text', notNull: true },
    secret_encrypted: { type: 'bytea', notNull: true },
    events:           { type: 'text[]', notNull: true, default: pgm.func("'{}'::text[]") },
    enabled:          { type: 'boolean', notNull: true, default: true },
    created_at:       { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('event_webhooks', 'tenant_id');
};

exports.down = (pgm) => {
  pgm.dropTable('event_webhooks');
};
