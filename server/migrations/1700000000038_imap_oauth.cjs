/* eslint-disable camelcase */
// M365 killed Basic auth for IMAP (SMTP AUTH is the only legacy exception), so
// Microsoft mailboxes authenticate via device-code OAuth: we store an encrypted
// refresh token and mint an access token per sync (XOAUTH2).
exports.up = (pgm) => {
  pgm.addColumns('imap_configs', {
    auth_type: { type: 'text', notNull: true, default: 'password', check: "auth_type IN ('password','xoauth2')" },
    oauth_client_id: { type: 'text' },
    oauth_tenant: { type: 'text' },
    oauth_refresh_token_encrypted: { type: 'bytea' },
  });
  pgm.alterColumn('imap_configs', 'password_encrypted', { notNull: false });
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM imap_configs WHERE auth_type = 'xoauth2'`);
  pgm.alterColumn('imap_configs', 'password_encrypted', { notNull: true });
  pgm.dropColumns('imap_configs', ['auth_type', 'oauth_client_id', 'oauth_tenant', 'oauth_refresh_token_encrypted']);
};
