/* eslint-disable camelcase */
// Marketing: allow campaigns to carry file attachments (e.g. PDFs).
// Stored as a jsonb array of { filename, content (base64), content_type }, mirroring
// the per-email `attachments` column the send dispatcher already understands.
exports.up = (pgm) => {
  pgm.addColumn('campaigns', {
    attachments: { type: 'jsonb', notNull: true, default: '[]' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('campaigns', ['attachments']);
};
