/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.createTable('tenants', {
    id:         { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name:       { type: 'text', notNull: true },
    slug:       { type: 'text', notNull: true, unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createTable('users', {
    id:                { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:         { type: 'uuid', references: 'tenants(id)', onDelete: 'CASCADE' },
    email:             { type: 'text', notNull: true },
    password_hash:     { type: 'text', notNull: true },
    role:              { type: 'text', notNull: true, check: "role IN ('super_admin','tenant_admin','tenant_user')" },
    invite_token:      { type: 'text' },
    invite_expires_at: { type: 'timestamptz' },
    created_at:        { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('users', 'users_tenant_email_uniq', { unique: ['tenant_id', 'email'] });
  pgm.createIndex('users', ['invite_token'], { where: 'invite_token IS NOT NULL' });
  pgm.createTable('sessions', {
    sid:    { type: 'text', primaryKey: true },
    sess:   { type: 'jsonb', notNull: true },
    expire: { type: 'timestamptz', notNull: true },
  });
  pgm.createIndex('sessions', ['expire']);
};
exports.down = (pgm) => {
  pgm.dropTable('sessions');
  pgm.dropTable('users');
  pgm.dropTable('tenants');
};
