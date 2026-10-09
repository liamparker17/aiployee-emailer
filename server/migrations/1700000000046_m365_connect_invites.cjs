/* eslint-disable camelcase */
// Emailed device-code connection links for Microsoft 365 mailboxes.
//
// One row per invite. Only the SHA-256 of the link token is stored. The Microsoft device_code
// is stored AES-256-GCM encrypted (EMAILER_ENC_KEY) and is never returned to a browser.
// Deliberately a separate table from feat/microsoft-invite-connect's `sender_invites`
// (that branch is auth-code+PKCE with our own app and is not merged), so both can coexist.
exports.up = (pgm) => {
  pgm.createTable('m365_connect_invites', {
    id:                 { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id:          { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    mailbox:            { type: 'text', notNull: true },   // expected sender, lower-cased
    recipient_email:    { type: 'text', notNull: true },   // who got the link, lower-cased
    display_name:       { type: 'text', notNull: true },
    allow_shared:       { type: 'boolean', notNull: true, default: false },
    token_hash:         { type: 'text', notNull: true, unique: true },
    status:             {
      type: 'text', notNull: true, default: 'pending',
      check: "status IN ('pending','connected','failed','revoked')",
    },
    expires_at:         { type: 'timestamptz', notNull: true },
    used_at:            { type: 'timestamptz' },
    created_by_user_id: { type: 'uuid' },
    created_by_email:   { type: 'text', notNull: true },
    // device-code flow state
    device_code_enc:    { type: 'bytea' },
    user_code:          { type: 'text' },
    verification_uri:   { type: 'text' },
    device_expires_at:  { type: 'timestamptz' },
    poll_interval:      { type: 'int', notNull: true, default: 5 },
    next_poll_at:       { type: 'timestamptz' },
    restarts:           { type: 'int', notNull: true, default: 0 },
    start_count:        { type: 'int', notNull: true, default: 0 },
    mismatch_count:     { type: 'int', notNull: true, default: 0 },
    failure_reason:     { type: 'text' },
    sender_id:          { type: 'uuid', references: 'senders(id)', onDelete: 'SET NULL' },
    connected_at:       { type: 'timestamptz' },
    created_at:         { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at:         { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('m365_connect_invites', ['tenant_id', 'created_at']);
};

exports.down = (pgm) => {
  pgm.dropTable('m365_connect_invites');
};
