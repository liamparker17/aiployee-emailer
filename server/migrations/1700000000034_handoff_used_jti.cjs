/* Cross-app SSO replay guard: each handoff token's jti may be redeemed once. */
exports.up = (pgm) => {
  pgm.createTable('handoff_used_jti', {
    jti: { type: 'uuid', primaryKey: true },
    used_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('handoff_used_jti', 'used_at');
};

exports.down = (pgm) => {
  pgm.dropTable('handoff_used_jti');
};
