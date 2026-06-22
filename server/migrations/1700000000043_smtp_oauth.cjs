/* eslint-disable camelcase */
// OAuth (XOAUTH2) outbound sending for M365: an smtp_config can authenticate via a stored
// OAuth refresh token instead of a password (mirrors imap_configs' oauth columns).
exports.up = (pgm) => {
  pgm.addColumns('smtp_configs', {
    auth_type: { type: 'text', notNull: true, default: 'password', check: "auth_type IN ('password','xoauth2')" },
    oauth_client_id: { type: 'text' },
    oauth_tenant: { type: 'text' },
    oauth_refresh_token_encrypted: { type: 'bytea' },
  });
  pgm.alterColumn('smtp_configs', 'password_encrypted', { notNull: false });
};
exports.down = (pgm) => {
  pgm.alterColumn('smtp_configs', 'password_encrypted', { notNull: true });
  pgm.dropColumns('smtp_configs', ['auth_type', 'oauth_client_id', 'oauth_tenant', 'oauth_refresh_token_encrypted']);
};
