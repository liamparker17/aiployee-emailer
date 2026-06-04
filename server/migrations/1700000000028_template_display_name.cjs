/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.addColumn('templates', { display_name: { type: 'text' } });
  pgm.addColumn('emails', { from_display_name: { type: 'text' } });
};
exports.down = (pgm) => {
  pgm.dropColumn('templates', 'display_name');
  pgm.dropColumn('emails', 'from_display_name');
};
