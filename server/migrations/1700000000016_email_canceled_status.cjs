/* eslint-disable camelcase */
// Allow canceling a scheduled (queued) email: extend the emails.status check.
const WITH = "status IN ('queued','sending','sent','failed','bounced','complained','suppressed','canceled')";
const WITHOUT = "status IN ('queued','sending','sent','failed','bounced','complained','suppressed')";
exports.up = (pgm) => {
  pgm.sql('ALTER TABLE emails DROP CONSTRAINT IF EXISTS emails_status_check');
  pgm.sql(`ALTER TABLE emails ADD CONSTRAINT emails_status_check CHECK (${WITH})`);
};
exports.down = (pgm) => {
  pgm.sql('ALTER TABLE emails DROP CONSTRAINT IF EXISTS emails_status_check');
  pgm.sql(`ALTER TABLE emails ADD CONSTRAINT emails_status_check CHECK (${WITHOUT})`);
};
