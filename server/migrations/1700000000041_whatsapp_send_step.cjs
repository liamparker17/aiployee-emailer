/* eslint-disable camelcase */
// Flows learn a WhatsApp channel: allow the whatsapp_send step kind.
exports.up = (pgm) => {
  pgm.sql('ALTER TABLE flow_steps DROP CONSTRAINT flow_steps_kind_check');
  pgm.addConstraint('flow_steps', 'flow_steps_kind_check', {
    check: "kind IN ('wait','jobix_call','email','condition','whatsapp_send')",
  });
};

exports.down = (pgm) => {
  pgm.sql("DELETE FROM flow_steps WHERE kind = 'whatsapp_send'");
  pgm.dropConstraint('flow_steps', 'flow_steps_kind_check');
  pgm.addConstraint('flow_steps', 'flow_steps_kind_check', {
    check: "kind IN ('wait','jobix_call','email','condition')",
  });
};
