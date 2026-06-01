/* eslint-disable camelcase */
// Abe ACT: link sent emails to a play (for outcome measurement) + record when execution began.
exports.up = (pgm) => {
  pgm.addColumn('emails', {
    play_id: { type: 'uuid', references: 'agent_plays(id)', onDelete: 'SET NULL' },
  });
  pgm.createIndex('emails', ['play_id'], { where: 'play_id IS NOT NULL', name: 'emails_play_id_idx' });
  pgm.addColumn('agent_plays', {
    executed_at: { type: 'timestamptz' },
  });
};
exports.down = (pgm) => {
  pgm.dropColumn('agent_plays', 'executed_at');
  pgm.dropIndex('emails', ['play_id'], { name: 'emails_play_id_idx' });
  pgm.dropColumn('emails', 'play_id');
};
