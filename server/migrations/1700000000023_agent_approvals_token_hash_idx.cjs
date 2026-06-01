/* eslint-disable camelcase */
// Single-use approval-token lookups query agent_approvals by token_hash; index it.
exports.up = (pgm) => {
  pgm.createIndex('agent_approvals', ['token_hash'], { name: 'agent_approvals_token_hash_idx' });
};
exports.down = (pgm) => {
  pgm.dropIndex('agent_approvals', ['token_hash'], { name: 'agent_approvals_token_hash_idx' });
};
