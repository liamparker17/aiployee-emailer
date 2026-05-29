/* eslint-disable camelcase */
// Allow a (revoked) API key to be hard-deleted without deleting its email-log
// history: emails.api_key_id becomes NULL instead of blocking the delete.
exports.up = (pgm) => {
  pgm.dropConstraint('emails', 'emails_api_key_id_fkey');
  pgm.addConstraint('emails', 'emails_api_key_id_fkey', {
    foreignKeys: { columns: 'api_key_id', references: 'api_keys(id)', onDelete: 'SET NULL' },
  });
};
exports.down = (pgm) => {
  pgm.dropConstraint('emails', 'emails_api_key_id_fkey');
  pgm.addConstraint('emails', 'emails_api_key_id_fkey', {
    foreignKeys: { columns: 'api_key_id', references: 'api_keys(id)' },
  });
};
