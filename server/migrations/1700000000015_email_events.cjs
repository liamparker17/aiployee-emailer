/* eslint-disable camelcase */
// Open/click engagement tracking: one row per open (pixel hit) or click (link redirect).
exports.up = (pgm) => {
  pgm.createTable('email_events', {
    id:         { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    email_id:   { type: 'uuid', notNull: true, references: 'emails(id)', onDelete: 'CASCADE' },
    tenant_id:  { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    type:       { type: 'text', notNull: true, check: "type IN ('open','click')" },
    url:        { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('email_events', ['email_id']);
  pgm.createIndex('email_events', ['tenant_id', { name: 'created_at', sort: 'DESC' }]);
};
exports.down = (pgm) => {
  pgm.dropTable('email_events');
};
