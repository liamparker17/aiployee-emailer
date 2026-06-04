/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.addColumn('line_report_configs', {
    client_name: { type: 'text' },
    client_context: { type: 'text' },
  });
};
exports.down = (pgm) => {
  pgm.dropColumn('line_report_configs', 'client_name');
  pgm.dropColumn('line_report_configs', 'client_context');
};
