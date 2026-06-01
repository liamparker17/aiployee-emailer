/* eslint-disable camelcase */
// Persistent chat messages between a tenant admin and Abe — one ongoing conversation per tenant.
exports.up = (pgm) => {
  pgm.createTable('agent_chat_messages', {
    id:         { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:  { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    role:       { type: 'text', notNull: true, check: "role IN ('user','abe')" },
    content:    { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('agent_chat_messages', ['tenant_id', { name: 'created_at', sort: 'ASC' }]);
};
exports.down = (pgm) => {
  pgm.dropTable('agent_chat_messages');
};
