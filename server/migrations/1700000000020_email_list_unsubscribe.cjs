/* eslint-disable camelcase */
// Per-recipient List-Unsubscribe URL for campaign emails (one-click unsubscribe header).
exports.up = (pgm) => {
  pgm.addColumn('emails', { list_unsubscribe: { type: 'text' } });
};
exports.down = (pgm) => {
  pgm.dropColumn('emails', 'list_unsubscribe');
};
