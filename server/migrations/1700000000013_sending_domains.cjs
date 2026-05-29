/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.createTable('sending_domains', {
    id:              { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:       { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    domain:          { type: 'text', notNull: true },
    verified:        { type: 'boolean', notNull: true, default: false },
    spf_ok:          { type: 'boolean', notNull: true, default: false },
    dmarc_ok:        { type: 'boolean', notNull: true, default: false },
    last_checked_at: { type: 'timestamptz' },
    created_at:      { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('sending_domains', 'sending_domains_tenant_domain_uniq', { unique: ['tenant_id', 'domain'] });
  pgm.createIndex('sending_domains', 'tenant_id');
};

exports.down = (pgm) => {
  pgm.dropTable('sending_domains');
};
