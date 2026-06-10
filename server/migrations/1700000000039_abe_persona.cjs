/* eslint-disable camelcase */
// Per-tenant Abe persona: replaces the default identity block of his system
// prompt (the hard rules are never replaceable). Nullable = default persona.
exports.up = (pgm) => {
  pgm.addColumns('agent_goals', {
    persona: { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('agent_goals', ['persona']);
};
