/* eslint-disable camelcase */
// Phase 2: outbound webhook to Jobix so the emailer can report thread outcomes back
// to the swarm. URL + an HMAC signing secret (encrypted), per tenant.
exports.up = (pgm) => {
  pgm.addColumns('agent_configs', {
    jobix_webhook_url:              { type: 'text' },
    jobix_webhook_secret_encrypted: { type: 'bytea' },
  });
};
exports.down = (pgm) => {
  pgm.dropColumns('agent_configs', ['jobix_webhook_url', 'jobix_webhook_secret_encrypted']);
};
