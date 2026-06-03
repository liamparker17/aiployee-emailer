/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.addColumn('line_report_configs', {
    ingest_sends_as_calls: { type: 'boolean', notNull: true, default: false },
  });
};
exports.down = (pgm) => { pgm.dropColumn('line_report_configs', 'ingest_sends_as_calls'); };
