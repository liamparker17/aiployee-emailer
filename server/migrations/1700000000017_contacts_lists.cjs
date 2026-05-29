/* eslint-disable camelcase */
// Marketing Phase A: contacts (with custom attributes) + lists + membership.
exports.up = (pgm) => {
  pgm.createTable('contacts', {
    id:              { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:       { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    email:           { type: 'text', notNull: true },
    name:            { type: 'text' },
    attributes:      { type: 'jsonb', notNull: true, default: '{}' },
    subscribed:      { type: 'boolean', notNull: true, default: true },
    unsubscribed_at: { type: 'timestamptz' },
    created_at:      { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('contacts', 'contacts_tenant_email_uniq', { unique: ['tenant_id', 'email'] });

  pgm.createTable('contact_lists', {
    id:         { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:  { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    name:       { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('contact_lists', ['tenant_id']);

  pgm.createTable('contact_list_members', {
    list_id:    { type: 'uuid', notNull: true, references: 'contact_lists(id)', onDelete: 'CASCADE' },
    contact_id: { type: 'uuid', notNull: true, references: 'contacts(id)', onDelete: 'CASCADE' },
    added_at:   { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('contact_list_members', 'contact_list_members_pk', { primaryKey: ['list_id', 'contact_id'] });
  pgm.createIndex('contact_list_members', ['contact_id']);
};
exports.down = (pgm) => {
  pgm.dropTable('contact_list_members');
  pgm.dropTable('contact_lists');
  pgm.dropTable('contacts');
};
