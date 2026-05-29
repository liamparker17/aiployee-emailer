/* eslint-disable camelcase */
// Phase 3: tenant-configured MCP servers the agent can call as tools.
exports.up = (pgm) => {
  pgm.createTable('mcp_servers', {
    id:                  { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:           { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    name:                { type: 'text', notNull: true },
    url:                 { type: 'text', notNull: true },
    auth_header_encrypted: { type: 'bytea' }, // optional bearer/header value sent to the MCP server
    enabled:             { type: 'boolean', notNull: true, default: true },
    created_at:          { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('mcp_servers', ['tenant_id']);
};
exports.down = (pgm) => {
  pgm.dropTable('mcp_servers');
};
