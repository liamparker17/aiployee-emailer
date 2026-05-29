/* eslint-disable camelcase */
// Marketing Phase B: campaigns table + campaign_id FK on emails.
exports.up = (pgm) => {
  pgm.createTable('campaigns', {
    id:            { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:     { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    name:          { type: 'text', notNull: true },
    sender_id:     { type: 'uuid', notNull: true, references: 'senders(id)' },
    template_id:   { type: 'uuid', references: 'templates(id)' },
    subject:       { type: 'text' },
    body_html:     { type: 'text' },
    audience_type: {
      type: 'text',
      notNull: true,
      check: "audience_type IN ('list','segment')",
    },
    audience_id:   { type: 'uuid', notNull: true },
    scheduled_for: { type: 'timestamptz' },
    status: {
      type: 'text',
      notNull: true,
      default: 'draft',
      check: "status IN ('draft','scheduled','sending','sent','canceled')",
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('campaigns', ['tenant_id']);

  pgm.addColumn('emails', {
    campaign_id: {
      type: 'uuid',
      references: 'campaigns(id)',
      onDelete: 'SET NULL',
    },
  });

  pgm.createIndex('emails', ['campaign_id']);
};

exports.down = (pgm) => {
  pgm.dropColumns('emails', ['campaign_id']);
  pgm.dropTable('campaigns');
};
